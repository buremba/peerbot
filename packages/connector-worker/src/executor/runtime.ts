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
}): Promise<ExecutorResult> {
  const executor = params.executor ?? new SubprocessExecutor();
  return executor.execute(params.compiledCode, params.job, params.hooks, {
    nixPackages: params.nixPackages,
  });
}
