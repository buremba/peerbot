import type { ExecutionLane } from '@lobu/core/contracts/worker/protocol';
import type {
  ExecutionHooks,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from './interface.js';
import { selectExecutor } from './select.js';

/**
 * Top-level entry point used by the daemon executor. Just delegates to a
 * `SyncExecutor` implementation (chosen by `lane`, `SubprocessExecutor` when
 * unset) with the V1 SDK shapes — no more magic-key adapter layer in between.
 */
export async function executeCompiledConnector(params: {
  compiledCode: string;
  job: ExecutorJob;
  executor?: SyncExecutor;
  hooks?: ExecutionHooks;
  /** Native (nixpkgs) packages the connector declared in `runtime.nix.packages`. */
  nixPackages?: string[];
  /**
   * Hard wall-clock limit for this connector run. Only applies to the
   * executor chosen here; an injected `executor` owns its own budget.
   */
  timeoutMs?: number;
  /**
   * Execution lane. `'isolate'` requires `isolated-vm` on this host and
   * rejects otherwise; unset or `'process'` forks a Node child as before.
   */
  lane?: ExecutionLane | null;
}): Promise<ExecutorResult> {
  const executor =
    params.executor ??
    (await selectExecutor({ lane: params.lane, timeoutMs: params.timeoutMs }));
  return executor.execute(params.compiledCode, params.job, params.hooks, {
    nixPackages: params.nixPackages,
  });
}
