/**
 * MCP Tool Registry
 *
 * This file defines all MCP tools and imports their Typebox schemas from tool files.
 * Typebox provides compile-time type safety and runtime JSON schema generation.
 *
 * Glossary — "namespace" in tool descriptions below means three different things,
 * none of which is a memory-scope axis:
 *   1. `search_sdk`'s `namespace` param — a ClientSDK module name
 *      (`watchers`, `entities`, `knowledge`, ...).
 *   2. `resolve_path`'s "namespace-based URL path" — the first URL segment
 *      (org slug or entity-type slug).
 *   3. `entity_identities.namespace` (deep in SQL) — the identifier type
 *      (`email`, `phone`, `wa_jid`); see `identity-normalize.ts`.
 *
 * Memory scoping uses `events.metadata.agent_id` (filtered via
 * `search_memory`'s top-level `agent_id` arg) — not any of the above.
 */

import { getPublicReadableActions, getRequiredAccessLevel } from '../auth/tool-access';
import type { Env } from '../index';
import { INTERNAL_REST_TOOLS } from './admin';
import { MetricSeriesSchema, metricSeries } from './admin/metric_series';
import { QuerySqlSchema, querySql } from './admin/query_sql';
import { ListOrganizationsSchema } from './organizations';
import { ResolvePathSchema, resolvePath } from './resolve_path';
import { SaveContentSchema, saveContent } from './save_content';
import { SearchSchema, search } from './search';
import { QuerySchema, RunSchema, querySdkScript, runSdkScript } from './sdk_run';
import { SdkSearchSchema, sdkSearch } from './sdk_search';

// ============================================
// Tool Definitions
// ============================================

/**
 * MCP Tool Annotations
 * @see https://developers.openai.com/apps-sdk/reference#annotations
 */
export interface ToolAnnotations {
  /** Signal that the tool is read-only. ChatGPT can skip 'Are you sure?' prompts when true. */
  readOnlyHint?: boolean;
  /** Declare that the tool may delete or overwrite user data, requiring explicit approval. */
  destructiveHint?: boolean;
  /** Declare that the tool publishes content or reaches outside the current user's account. */
  openWorldHint?: boolean;
  /** Declare that calling the tool repeatedly with the same arguments has no additional effect. */
  idempotentHint?: boolean;
}

export type TokenType = 'oauth' | 'session' | 'pat' | 'anonymous';

/**
 * Tool execution context from authentication
 * Passed to all tool handlers for organization scoping
 */
export interface ToolContext {
  /** User's organization ID - REQUIRED for all operations */
  organizationId: string;
  /** User ID from OAuth token, PAT, or session (null for anonymous public reads) */
  userId: string | null;
  /** Caller's role in the organization (null for non-members reading a public workspace). */
  memberRole: string | null;
  /** Durable Lobu/Lobu agent identity bound to this MCP session, when provided. */
  agentId?: string | null;
  /** Whether request was authenticated */
  isAuthenticated: boolean;
  /** OAuth client ID that created this request (null for session/anonymous) */
  clientId?: string | null;
  /** OAuth scopes granted to this MCP/tool session, when applicable. */
  scopes?: string[] | null;
  tokenType: TokenType;
  /** True when the MCP URL pinned an org slug (e.g. `/mcp/acme`). */
  scopedToOrg: boolean;
  /**
   * Whether `client.org(other)` is allowed inside the sandbox. Computed at session
   * start as `tokenType === 'oauth' && !scopedToOrg`.
   */
  allowCrossOrg: boolean;
  /**
   * Set by the sandbox when the script's wall-clock budget runs out. Handlers
   * that opt in (today: `query_sql` and `client.query`) race their work
   * against this signal so the awaiting caller unblocks immediately. The
   * underlying postgres connection isn't cancelled — `statement_timeout` is
   * the actual server-side cap.
   */
  abortSignal?: AbortSignal;
  /** Original request URL, used to derive public-facing origin for URL generation */
  requestUrl?: string;
  /** PUBLIC_WEB_URL env var fallback for URL generation when requestUrl is unreliable */
  baseUrl?: string;
}

export interface ToolDefinition<T = any> {
  name: string;
  description: string;
  inputSchema: any; // JSON Schema
  annotations?: ToolAnnotations;
  /** Internal tools are excluded from external MCP clients (only available to the frontend) */
  internal?: boolean;
  handler: (args: T, env: Env, ctx: ToolContext) => Promise<any>;
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;

const TOOLS: ToolDefinition[] = [
  // ─── Memory hot path — read ───────────────────────────────────────────────
  {
    name: 'search_memory',
    description:
      'Search saved workspace memory: entities, facts, decisions, preferences, observations, and notes. Use this to answer “what do we know?” Pair writes with `save_memory`; use `search_sdk` / `query_sdk` only when you need SDK capabilities or programmable reads.',
    inputSchema: SearchSchema,
    annotations: READ_ONLY,
    handler: search,
  },
  {
    name: 'save_memory',
    description:
      "Save user-shared facts, preferences, decisions, observations, and notes to workspace memory. Storage is append-only — pass `supersedes_event_id` to replace an existing fact (the old event is hidden from future searches without losing history). Optionally attach to entities via `entity_ids`. Always search first to avoid duplicates.",
    inputSchema: SaveContentSchema,
    annotations: { destructiveHint: false },
    handler: saveContent,
  },
  // ─── Discovery ────────────────────────────────────────────────────────────
  {
    name: 'list_organizations',
    description:
      'List organizations the authenticated user belongs to, plus any public workspaces the session can read. The response marks the bound org with `is_current: true` — that is the default target for memory and SDK calls. Use the slug with `client.org(slug)` from `query_sdk` / `run_sdk` for cross-org reads on /mcp + OAuth, or reconnect to /mcp/{slug} to pin a different default.',
    inputSchema: ListOrganizationsSchema,
    annotations: READ_ONLY,
    handler: async () => {
      throw new Error('Handled directly in executeTool');
    },
  },
  {
    name: 'search_sdk',
    description:
      "Search ClientSDK documentation and method metadata. Use this to discover which SDK method exists and how to call it; it does not query workspace data. Pass a namespace ('watchers', 'entities', etc.), a dotted path ('watchers.create'), or a free-text query. Pair with `query_sdk` (read-only) or `run_sdk` (full SDK) to actually call methods.",
    inputSchema: SdkSearchSchema,
    annotations: READ_ONLY,
    handler: sdkSearch,
  },
  // ─── Power tools — TS scripting + raw SQL ─────────────────────────────────
  {
    name: 'query_sdk',
    description:
      'Run read-only TypeScript in a sandboxed isolate over the ClientSDK. Use this to fetch workspace data through typed SDK methods. The script signature is `export default async (ctx, client) => ...`. Mutating methods are absent from `client` — attempts surface as undefined methods; use `run_sdk` for writes. Output capped at 1 MB. Use `search_sdk` to find method names. Example: `export default async (_ctx, client) => client.entities.list({ entity_type: "company" });`',
    inputSchema: QuerySchema,
    annotations: READ_ONLY,
    handler: querySdkScript,
  },
  {
    name: 'query_sql',
    description:
      'Run a paginated, sortable, searchable read-only SQL query. Table references auto-scope to the bound org. Do NOT include ORDER BY/LIMIT/OFFSET or positional parameters. Optional `org_slug` (OAuth on /mcp only) redirects the query to a different member org; rejected on /mcp/{slug} and on PAT auth.',
    inputSchema: QuerySqlSchema,
    annotations: READ_ONLY,
    handler: querySql,
  },
  {
    name: 'metric_series',
    description:
      'Run a read-only time-series SQL for dashboard sparklines. Caller passes a single SELECT returning a bucket column + N numeric stat columns; the same validator/auto-scoper that powers `query_sql` injects `$1 = organization_id`. Returns `{ columns, rows }` for direct frontend consumption.',
    inputSchema: MetricSeriesSchema,
    annotations: READ_ONLY,
    internal: true,
    handler: metricSeries,
  },
  {
    name: 'run_sdk',
    description:
      'Destructive — confirm before running. Runs TypeScript in a sandboxed isolate over the FULL ClientSDK. Use this for SDK writes or multi-step workflows. Signature: `export default async (ctx, client) => ...`. Can mutate entities, watchers, memory, classifiers, connections, etc. Use `query_sdk` for reads. Pass `dry_run: true` to execute reads while skipping write/external SDK calls and returning `side_effect_preview`. Output capped at 1 MB. Example: `export default async (_ctx, client) => client.entities.create({ type: "company", name: "Acme" });`',
    inputSchema: RunSchema,
    annotations: { destructiveHint: true },
    handler: runSdkScript,
  },
  // ─── REST/session/CLI surface (manage_*, list_watchers, get_watcher, ...) ─
  ...INTERNAL_REST_TOOLS,
  // ─── Path resolution (frontend internal) ──────────────────────────────────
  {
    name: 'resolve_path',
    description:
      'Resolve a namespace-based URL path like /acme/entity-type/entity-slug into namespace and entity details. Returns template_data with executed data source query results when templates define data_sources.',
    inputSchema: ResolvePathSchema,
    annotations: READ_ONLY,
    internal: true,
    handler: resolvePath,
  },
];

// ============================================
// Helper Functions
// ============================================

// TOOLS is a module constant with no runtime mutation — index it once.
const TOOLS_BY_NAME: Map<string, ToolDefinition> = new Map(
  TOOLS.map((tool) => [tool.name, tool])
);

/**
 * Get tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS_BY_NAME.get(name);
}

/**
 * Flatten a TypeBox Union (anyOf) schema into a single object schema.
 * Each variant must be an object with an `action` literal discriminator.
 * Result: single object with `action` as a string enum, all other
 * properties merged (only `action` is required).
 */
function flattenUnionSchema(schema: any): any {
  const variants: any[] = schema.anyOf || schema.oneOf;
  const actionValues: string[] = [];
  const mergedProperties: Record<string, any> = {};

  for (const variant of variants) {
    if (variant.type !== 'object' || !variant.properties) continue;
    for (const [key, prop] of Object.entries<any>(variant.properties)) {
      if (key === 'action') {
        if (prop.const) actionValues.push(prop.const);
        continue;
      }
      // First occurrence wins (keeps description from the first variant that defines it)
      if (!mergedProperties[key]) {
        mergedProperties[key] = prop;
      }
    }
  }

  return {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: actionValues, description: 'Action to perform' },
      ...mergedProperties,
    },
    required: ['action'],
  };
}

function filterSchemaForPublicActions(toolName: string, schema: any): any | null {
  const allowedActions = getPublicReadableActions(toolName);
  if (allowedActions === undefined) return null;
  if (allowedActions === null) return schema;

  const variants: any[] = schema?.anyOf || schema?.oneOf;
  if (!Array.isArray(variants)) return schema;

  const filteredVariants = variants.filter((variant) => {
    const actionConst = variant?.properties?.action?.const;
    return typeof actionConst === 'string' && allowedActions.has(actionConst);
  });

  if (filteredVariants.length === 0) return null;
  return {
    ...schema,
    ...(schema.anyOf ? { anyOf: filteredVariants } : {}),
    ...(schema.oneOf ? { oneOf: filteredVariants } : {}),
  };
}

function accessLevelRank(level: 'read' | 'write' | 'admin'): number {
  if (level === 'read') return 1;
  if (level === 'write') return 2;
  return 3;
}

function filterSchemaForAccessLevel(
  toolName: string,
  schema: any,
  readOnlyHint: boolean,
  maxAccessLevel: 'read' | 'write' | 'admin'
): any | null {
  const toolAccess = getRequiredAccessLevel(toolName, {}, readOnlyHint);
  if (accessLevelRank(toolAccess) <= accessLevelRank(maxAccessLevel)) {
    const variants: any[] = schema?.anyOf || schema?.oneOf;
    if (!Array.isArray(variants)) return schema;

    const filteredVariants = variants.filter((variant) => {
      const actionConst = variant?.properties?.action?.const;
      if (typeof actionConst !== 'string') return false;
      return (
        accessLevelRank(getRequiredAccessLevel(toolName, { action: actionConst }, readOnlyHint)) <=
        accessLevelRank(maxAccessLevel)
      );
    });

    if (filteredVariants.length === 0) return null;
    return {
      ...schema,
      ...(schema.anyOf ? { anyOf: filteredVariants } : {}),
      ...(schema.oneOf ? { oneOf: filteredVariants } : {}),
    };
  }

  return null;
}

// The tool registry + its schemas are static after module load, so the
// computed tool list depends only on the three options. Memoize per option
// tuple (a handful of distinct values in practice).
const allToolsCache = new Map<string, ReturnType<typeof computeAllTools>>();

/**
 * Get all tool definitions for MCP tools/list
 */
export function getAllTools(options?: {
  includeInternalTools?: boolean;
  publicOnly?: boolean;
  maxAccessLevel?: 'read' | 'write' | 'admin';
}) {
  const includeInternalTools = options?.includeInternalTools ?? true;
  const publicOnly = options?.publicOnly ?? false;
  const maxAccessLevel = options?.maxAccessLevel ?? 'admin';
  const cacheKey = `${includeInternalTools ? 1 : 0}:${publicOnly ? 1 : 0}:${maxAccessLevel}`;
  let cached = allToolsCache.get(cacheKey);
  if (!cached) {
    cached = computeAllTools(includeInternalTools, publicOnly, maxAccessLevel);
    allToolsCache.set(cacheKey, cached);
  }
  return cached;
}

function computeAllTools(
  includeInternalTools: boolean,
  publicOnly: boolean,
  maxAccessLevel: 'read' | 'write' | 'admin'
) {
  return TOOLS.filter((tool) => includeInternalTools || !tool.internal)
    .filter((tool) => !publicOnly || getPublicReadableActions(tool.name) !== undefined)
    .map((tool) => {
      let inputSchema = tool.inputSchema;
      const readOnlyHint = tool.annotations?.readOnlyHint === true;

      if (publicOnly) {
        inputSchema = filterSchemaForPublicActions(tool.name, inputSchema);
      }
      if (!inputSchema) return null;

      inputSchema = filterSchemaForAccessLevel(
        tool.name,
        inputSchema,
        readOnlyHint,
        maxAccessLevel
      );
      if (!inputSchema) return null;

      // Claude API rejects anyOf/oneOf/allOf at the top level of input_schema.
      // Flatten discriminated Union schemas into a single object.
      if (inputSchema.anyOf || inputSchema.oneOf) {
        inputSchema = flattenUnionSchema(inputSchema);
      } else if (inputSchema.type !== 'object') {
        inputSchema = { type: 'object' as const, ...inputSchema };
      }

      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
        ...(tool.annotations && { annotations: tool.annotations }),
      };
    })
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
}

