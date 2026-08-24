import type {
  ExecutionHooks,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from './interface.js';
import { SubprocessExecutor } from './subprocess.js';

/**
 * Top-level entry point used by the daemon executor. Just delegates to a
 * `SyncExecutor` implementation (defaults to `SubprocessExecutor`) with the
 * V1 SDK shapes — no more magic-key adapter layer in between.
 */
export async function executeCompiledConnector(params: {
  compiledCode: string;
  job: ExecutorJob;
  executor?: SyncExecutor;
  hooks?: ExecutionHooks;
  /** Native (nixpkgs) packages the connector declared in `runtime.nix.packages`. */
  nixPackages?: string[];
  /**
   * Hard wall-clock limit for this connector subprocess. Only applies to the
   * default `SubprocessExecutor`; an injected `executor` owns its own budget.
   */
  timeoutMs?: number;
}): Promise<ExecutorResult> {
  // Pass no options at all when unset: SubprocessExecutor spreads over its
  // defaults, so an explicit `{ timeoutMs: undefined }` would clobber them.
  const executor =
    params.executor ??
    new SubprocessExecutor(params.timeoutMs === undefined ? undefined : { timeoutMs: params.timeoutMs });
  return executor.execute(params.compiledCode, params.job, params.hooks, {
    nixPackages: params.nixPackages,
  });
}
