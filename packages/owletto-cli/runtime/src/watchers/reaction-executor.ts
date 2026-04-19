/**
 * Reaction Executor
 *
 * Executes compiled watcher reaction scripts in a QuickJS WASM sandbox.
 * Scripts interact with the system only through the ReactionSDK,
 * which is exposed as host functions via the sandbox env.
 */

import type { ReactionContext, ReactionSDK } from '@lobu/owletto-sdk';
import { getDb } from '../db/client';
import { validateAndScopeQuery } from '../utils/execute-data-sources';
import logger from '../utils/logger';
import { getOrganizationSlug, getPublicWebUrl } from '../utils/url-builder';
import { getAvailableOperations, trackWatcherReaction } from '../utils/watcher-reactions';

const REACTION_TIMEOUT_MS = 60_000;

export interface ExecuteReactionOptions {
  compiledScript: string;
  context: ReactionContext;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Build a ReactionSDK that delegates to existing tool handlers.
 * All mutations go through the same auth/validation as MCP calls.
 */
function buildReactionSDK(
  context: ReactionContext,
  env: Record<string, string | undefined>
): ReactionSDK {
  const { organization_id, window } = context;
  const watcherId = window.watcher_id;
  const windowId = window.id;
  // userId=null + isAuthenticated=true signals a system/internal call (e.g. reaction scripts).
  // canWriteEntity() in organization-access.ts grants write access on org match alone for this case.
  const toolCtx = { organizationId: organization_id, userId: null, isAuthenticated: true };
  const entityIds = context.entities.map((e) => e.id);

  function track(
    reactionType: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolResult?: Record<string, unknown>,
    entityId?: number
  ): Promise<void> {
    return trackWatcherReaction({
      organizationId: organization_id,
      watcherId,
      windowId,
      reactionType,
      toolName,
      toolArgs,
      toolResult,
      entityId,
    });
  }

  return {
    entities: {
      async get(id) {
        const sql = getDb();
        const rows = await sql`
          SELECT id, name, entity_type, metadata FROM entities WHERE id = ${id} AND organization_id = ${organization_id} LIMIT 1
        `;
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
          id: Number(r.id),
          name: r.name as string,
          entity_type: r.entity_type as string,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
        };
      },
      async create(params) {
        const { manageEntity } = await import('../tools/admin/manage_entity');
        const result = await manageEntity(
          {
            action: 'create',
            entity_type: params.type,
            name: params.name,
            metadata: params.metadata,
          } as any,
          env as any,
          toolCtx
        );
        const entity = (result as any)?.entity;
        if (!entity) throw new Error('manage_entity create did not return an entity');
        await track('entity_created', 'manage_entity', params, result as any, entity.id);
        return { id: entity.id, slug: entity.slug };
      },
      async update(params) {
        const { manageEntity } = await import('../tools/admin/manage_entity');
        const result = await manageEntity(
          {
            action: 'update',
            entity_id: params.entity_id,
            name: params.name,
            metadata: params.metadata,
          } as any,
          env as any,
          toolCtx
        );
        await track('entity_updated', 'manage_entity', params, result as any, params.entity_id);
      },
      async link(
        fromId: number,
        toId: number,
        relationshipType: string,
        metadata: Record<string, unknown>
      ) {
        const { manageEntity } = await import('../tools/admin/manage_entity');
        const result = await manageEntity(
          {
            action: 'link',
            from_entity_id: fromId,
            to_entity_id: toId,
            relationship_type_slug: relationshipType,
            metadata,
          } as any,
          env as any,
          toolCtx
        );
        await track(
          'entity_linked',
          'manage_entity',
          { from: fromId, to: toId, type: relationshipType },
          result as any
        );
      },
      async search(query: string, options?: { limit?: number }) {
        const limit = Math.min(options?.limit ?? 10, 100);
        const { search: searchTool } = await import('../tools/search');
        const result = await searchTool({ query, limit } as any, env as any, toolCtx);
        return ((result as any).results ?? []).map((r: any) => ({
          id: r.id,
          name: r.name,
          type: r.entity_type,
        }));
      },
    },
    actions: {
      async execute(connectionId: number, actionKey: string, input: Record<string, unknown>) {
        const { manageOperations } = await import('../tools/admin/manage_operations');
        const result = await manageOperations(
          {
            action: 'execute',
            connection_id: connectionId,
            operation_key: actionKey,
            input,
            watcher_source: { watcher_id: watcherId, window_id: windowId },
          } as any,
          env as any,
          toolCtx
        );
        return { run_id: (result as any).run_id ?? 0, output: (result as any).output ?? {} };
      },
      async listAvailable() {
        return getAvailableOperations(entityIds, organization_id);
      },
    },
    content: {
      async save(entityId: number, content: string, semanticType: string) {
        const { saveContent } = await import('../tools/save_content');
        await saveContent(
          {
            entity_ids: [entityId],
            content,
            semantic_type: semanticType,
            metadata: {},
            watcher_source: { watcher_id: watcherId, window_id: windowId },
          } as any,
          env as any,
          toolCtx
        );
      },
    },
    async notify(
      title: string,
      body: string,
      options?: { resource_url?: string; connection_id?: string }
    ) {
      let resourceUrl = options?.resource_url;
      if (!resourceUrl) {
        try {
          const ownerSlug = await getOrganizationSlug(organization_id);
          if (ownerSlug) {
            const base = getPublicWebUrl() ?? '';
            resourceUrl = `${base}/${ownerSlug}/watchers/${watcherId}`;
          }
        } catch {
          // Best-effort URL generation
        }
      }
      const connectionId = options?.connection_id ?? undefined;
      const { notify: notifyTool } = await import('../tools/admin/notify');
      await notifyTool(
        {
          action: 'send',
          title,
          body,
          resource_url: resourceUrl,
          connection_id: connectionId,
          watcher_source: { watcher_id: watcherId, window_id: windowId },
        } as any,
        env as any,
        toolCtx
      );
    },
    async query(querySql: string, _params: unknown[] = []) {
      // Validate, parse, and org-scope the query using the shared pipeline
      // (SQL parser + allowlisted tables + org-scoped CTEs).
      const scoped = validateAndScopeQuery(querySql, organization_id);
      const db = getDb();
      const rows = await db.begin(async (tx) => {
        await tx.unsafe('SET TRANSACTION READ ONLY');
        await tx.unsafe("SET LOCAL statement_timeout = '5000'");
        return tx.unsafe(scoped.sql, scoped.params as any[]);
      });
      await track('query', 'sql', { sql: querySql }, { row_count: rows.length });
      return rows.map((r: Record<string, unknown>) => ({ ...r }));
    },
    log(message: string, data?: Record<string, unknown>) {
      logger.info({ watcher_id: watcherId, window_id: windowId, ...data }, `[reaction] ${message}`);
      track('log', 'log', { message, ...data }).catch(() => {});
    },
  };
}

// Preamble injected into the guest to reconstruct sdk/ctx from flat env functions
const GUEST_PREAMBLE = `
const ctx = JSON.parse(env.__ctx);
const sdk = {
  entities: {
    get: async (id) => { const r = await env.__sdk_entities_get(JSON.stringify(id)); return JSON.parse(r); },
    create: async (params) => { const r = await env.__sdk_entities_create(JSON.stringify(params)); return JSON.parse(r); },
    update: async (params) => { await env.__sdk_entities_update(JSON.stringify(params)); },
    link: async (fromId, toId, type, metadata) => { await env.__sdk_entities_link(JSON.stringify({ fromId, toId, type, metadata })); },
    search: async (query, options) => { const r = await env.__sdk_entities_search(JSON.stringify({ query, options })); return JSON.parse(r); },
  },
  actions: {
    execute: async (connId, actionKey, input) => { const r = await env.__sdk_actions_execute(JSON.stringify({ connId, actionKey, input })); return JSON.parse(r); },
    listAvailable: async () => { const r = await env.__sdk_actions_listAvailable(); return JSON.parse(r); },
  },
  content: {
    save: async (entityId, content, semanticType) => { await env.__sdk_content_save(JSON.stringify({ entityId, content, semanticType })); },
  },
  notify: async (title, body, options) => { await env.__sdk_notify(JSON.stringify({ title, body, options })); },
  query: async (sql, params) => { const r = await env.__sdk_query(JSON.stringify({ sql, params })); return JSON.parse(r); },
  log: (message, data) => { env.__sdk_log(JSON.stringify({ message, data })); },
};
`;

/**
 * Build the flat env object that maps SDK methods to host-side async functions.
 * Values are serialized as JSON across the WASM boundary.
 */
function buildSandboxEnv(context: ReactionContext, sdk: ReactionSDK): Record<string, unknown> {
  return {
    __ctx: JSON.stringify(context),

    // entities
    __sdk_entities_get: async (argsJson: string) => {
      const id = JSON.parse(argsJson);
      const result = await sdk.entities.get(id);
      return JSON.stringify(result);
    },
    __sdk_entities_create: async (argsJson: string) => {
      const params = JSON.parse(argsJson);
      const result = await sdk.entities.create(params);
      return JSON.stringify(result);
    },
    __sdk_entities_update: async (argsJson: string) => {
      const params = JSON.parse(argsJson);
      await sdk.entities.update(params);
      return '{}';
    },
    __sdk_entities_link: async (argsJson: string) => {
      const { fromId, toId, type, metadata } = JSON.parse(argsJson);
      await sdk.entities.link(fromId, toId, type, metadata);
      return '{}';
    },
    __sdk_entities_search: async (argsJson: string) => {
      const { query, options } = JSON.parse(argsJson);
      const result = await sdk.entities.search(query, options);
      return JSON.stringify(result);
    },

    // actions
    __sdk_actions_execute: async (argsJson: string) => {
      const { connId, actionKey, input } = JSON.parse(argsJson);
      const result = await sdk.actions.execute(connId, actionKey, input);
      return JSON.stringify(result);
    },
    __sdk_actions_listAvailable: async () => {
      const result = await sdk.actions.listAvailable();
      return JSON.stringify(result);
    },

    // content
    __sdk_content_save: async (argsJson: string) => {
      const { entityId, content, semanticType } = JSON.parse(argsJson);
      await sdk.content.save(entityId, content, semanticType);
      return '{}';
    },

    // notify
    __sdk_notify: async (argsJson: string) => {
      const { title, body, options } = JSON.parse(argsJson);
      await sdk.notify(title, body, options);
      return '{}';
    },

    // query
    __sdk_query: async (argsJson: string) => {
      const { sql, params } = JSON.parse(argsJson);
      const result = await sdk.query(sql, params);
      return JSON.stringify(result);
    },

    // log (sync — fire and forget)
    __sdk_log: (argsJson: string) => {
      const { message, data } = JSON.parse(argsJson);
      sdk.log(message, data);
    },
  };
}

// Lazy-loaded sandbox runner
let runSandboxedFn: ((fn: any, opts?: any) => Promise<any>) | null = null;

async function getRunner() {
  if (!runSandboxedFn) {
    const { loadAsyncQuickJs } = await import('@sebastianwessel/quickjs');
    const variant = (await import('@jitl/quickjs-ng-wasmfile-release-asyncify')).default;
    const { runSandboxed } = await loadAsyncQuickJs(variant);
    runSandboxedFn = runSandboxed;
  }
  return runSandboxedFn;
}

/**
 * Execute a compiled reaction script in a QuickJS WASM sandbox.
 *
 * The script runs in complete isolation — no access to Node.js APIs,
 * filesystem, or host objects. SDK methods are exposed as env functions.
 */
export async function executeReaction(options: ExecuteReactionOptions): Promise<{
  success: boolean;
  error?: string;
}> {
  const { compiledScript, context, env, timeoutMs = REACTION_TIMEOUT_MS } = options;
  const sdk = buildReactionSDK(context, env);
  const sandboxEnv = buildSandboxEnv(context, sdk);
  const runSandboxed = await getRunner();

  const guestCode = `
${GUEST_PREAMBLE}

const module = { exports: {} };
const exports = module.exports;
${compiledScript}
const __react = module.exports?.react ?? exports?.react ?? (typeof react === 'function' ? react : undefined);
if (typeof __react !== 'function') {
  throw new Error('Reaction script must export a "react" function');
}
export default await __react(ctx, sdk);
`;

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Reaction script timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    const execPromise = runSandboxed(
      async ({ evalCode }: { evalCode: (code: string) => any }) => evalCode(guestCode),
      {
        allowFetch: false,
        allowFs: false,
        env: sandboxEnv,
        executionTimeout: timeoutMs,
      }
    );

    let result: any;
    try {
      result = await Promise.race([execPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (result && !result.ok) {
      const errorMessage =
        typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      logger.error(
        {
          watcher_id: context.window.watcher_id,
          window_id: context.window.id,
          error: errorMessage,
        },
        'Reaction script execution failed'
      );
      return { success: false, error: errorMessage };
    }

    logger.info(
      { watcher_id: context.window.watcher_id, window_id: context.window.id },
      'Reaction script executed successfully'
    );
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, watcher_id: context.window.watcher_id, window_id: context.window.id },
      'Reaction script execution failed'
    );
    return { success: false, error: errorMessage };
  }
}

/**
 * Compile a TypeScript reaction script to JavaScript using esbuild.
 */
export async function compileReactionScript(source: string): Promise<string> {
  const { compileSource } = await import('../utils/compiler-core');
  const result = await compileSource(source, {
    tmpPrefix: '.reaction-compile-',
    label: 'ReactionCompiler',
    buildOptions: {
      format: 'cjs',
      target: 'esnext',
      platform: 'node',
      external: ['@owletto/reactions'],
    },
  });
  return result.compiledCode;
}
