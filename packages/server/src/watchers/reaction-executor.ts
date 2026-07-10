/**
 * Reaction Executor
 *
 * Executes compiled watcher reaction scripts inside the shared `runScript`
 * isolate runner over the typed `ClientSDK`. Stored scripts MUST export
 * `default async (ctx, client, params?) => ...`; the legacy `react(ctx, sdk)`
 * export and the old `ReactionSDK` surface (actions/content/notify/query) are
 * gone. A one-time DB migration is required before deploy — see PR #348.
 *
 * Reactions run with `userId: null` + `isAuthenticated: true` so handler-
 * level access checks treat them as system calls, just like before.
 */

import type { ReactionContext } from '@lobu/connector-sdk';
import { SCOPE_CHECK_NOT_APPLICABLE } from '../auth/tool-access';
import type { Env } from '../index';
import { buildClientSDK } from '../sandbox/client-sdk';
import { runScript } from '../sandbox/run-script';
import { compileSource } from '../utils/compiler-core';
import logger from '../utils/logger';

const REACTION_TIMEOUT_MS = 60_000;

interface ExecuteReactionOptions {
  compiledScript: string;
  context: ReactionContext;
  env: Record<string, string | undefined>;
  /** Optional params object captured at reaction definition time. */
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Execute a compiled reaction script. Delegates to `runScript`, which compiles
 * the source via esbuild and runs it in an `isolated-vm` V8 isolate.
 */
export async function executeReaction(options: ExecuteReactionOptions): Promise<{
  success: boolean;
  error?: string;
}> {
  const { compiledScript, context, env, params, timeoutMs = REACTION_TIMEOUT_MS } = options;

  // Reactions are scoped to the watcher's own workspace — they have no user
  // identity to validate cross-org membership against, so `client.org(...)`
  // is intentionally disabled. The builder form lets the sandbox forward its
  // wall-clock signal into `ctx.abortSignal` so SQL via `client.query` can
  // cancel upstream when the script times out.
  const reactionCtx = {
    organizationId: context.organization_id,
    userId: null,
    memberRole: null,
    isAuthenticated: true,
    tokenType: 'session' as const,
    // System-tier reaction (no user identity): scope dimension does not apply.
    // It already qualifies as a system context, but pass the sentinel
    // explicitly so the scope guards never fail closed here.
    scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
    scopedToOrg: true,
    allowCrossOrg: false,
    // The reaction IS this watcher acting autonomously. Stamping the watcher id
    // here makes EVERY gated write it performs (connector ops, entity mutations,
    // watcher edits) resolve the watcher's owning agent and evaluate in
    // autonomous mode — the script cannot dodge its agent's envelope by omitting
    // an explicit `watcher_source`. `source: 'watcher-run'` marks the turn
    // autonomous even for surfaces that read only sourceContext.
    actingWatcherId: context.window.watcher_id,
    // The window too, so a deferred approval batches per window and dedups across
    // windows even when the script omits `watcher_source` (see ToolContext).
    actingWindowId: context.window.id,
    sourceContext: { source: 'watcher-run' as const },
  };

  const result = await runScript({
    source: compiledScript,
    sdk: (abortSignal) =>
      buildClientSDK(reactionCtx, env as Env, { allowCrossOrg: false, abortSignal }),
    allowCrossOrg: false,
    context: context as unknown as Record<string, unknown>,
    extraArgs: params ? [params] : [],
    limits: { timeoutMs },
  });

  if (result.success) {
    logger.info(
      {
        watcher_id: context.window.watcher_id,
        window_id: context.window.id,
        sdk_calls: result.sdkCalls,
        duration_ms: result.durationMs,
      },
      'Reaction script executed successfully'
    );
    return { success: true };
  }

  const errorMessage = result.error
    ? `${result.error.name}: ${result.error.message}`
    : 'Unknown reaction error';

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

/**
 * Compile a TypeScript reaction script to JavaScript using esbuild.
 *
 * Stays exported because `manage_watchers.set_reaction_script` calls it at
 * save time to surface compile errors back to the agent. Run-time compile
 * also happens inside `runScript` itself; this is a fast-path for
 * pre-validation.
 */
/**
 * Extract a reaction's exported `input` schema (a TypeBox schema, i.e. plain
 * JSON Schema) by loading the compiled module in the isolate WITHOUT invoking
 * its handler. This is how the watcher's extraction contract is derived from
 * the reaction: the worker is told the exact shape the reaction will
 * `Value.Parse`, so "the reaction owns the schema" holds end to end.
 *
 * Returns null when the reaction declares no `input` export (legacy/free-form
 * reactions) or the load fails — callers then fall back to `{ summary }`.
 */
export async function extractReactionInputSchema(
  source: string
): Promise<Record<string, unknown> | null> {
  // Pass RAW TS — runScript compiles it once (external:[], bundling the SDK).
  // Pre-compiling here would double-compile and mangle the named export.
  // Extract mode never invokes the handler, so the guest never touches the SDK
  // — a stub keeps this DB/env-free. The reaction's top-level only constructs
  // its `input` schema.
  const result = await runScript({
    source,
    sdk: {} as unknown as Parameters<typeof runScript>[0]['sdk'],
    allowCrossOrg: false,
    context: {},
    extractExport: 'input',
    limits: { timeoutMs: 5_000 },
  });
  if (!result.success) return null;
  const v = result.returnValue;
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export async function compileReactionScript(source: string): Promise<string> {
  // Match `runScript`'s execute-time esbuild config exactly so save-time and
  // runtime accept the same set of imports. Drift here used to externalize
  // `@lobu/reactions`, which the runtime recompile would then fail to
  // resolve.
  const result = await compileSource(source, {
    tmpPrefix: '.reaction-compile-',
    label: 'ReactionCompiler',
    buildOptions: {
      format: 'cjs',
      target: 'esnext',
      platform: 'node',
      external: [],
    },
  });
  return result.compiledCode;
}
