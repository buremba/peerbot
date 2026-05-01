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
import type { Env } from '../index';
import { buildClientSDK } from '../sandbox/client-sdk';
import { runScript } from '../sandbox/run-script';
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
    scopedToOrg: true,
    allowCrossOrg: false,
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
export async function compileReactionScript(source: string): Promise<string> {
  const { compileSource } = await import('../utils/compiler-core');
  // Match `runScript`'s execute-time esbuild config exactly so save-time and
  // runtime accept the same set of imports. Drift here used to externalize
  // `@owletto/reactions`, which the runtime recompile would then fail to
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
