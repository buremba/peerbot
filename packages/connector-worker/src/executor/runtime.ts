import type {
  ExecutionHooks,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from './interface.js';
import { selectExecutor } from './select.js';

/**
 * Top-level entry point used by the daemon executor. Just delegates to the
 * `SyncExecutor` `selectExecutor` builds — always an `IsolateExecutor` — with
 * the V1 SDK shapes, no magic-key adapter layer in between.
 */
export async function executeCompiledConnector(params: {
  compiledCode: string;
  job: ExecutorJob;
  executor?: SyncExecutor;
  hooks?: ExecutionHooks;
  /**
   * Hard wall-clock limit for this connector run. Only applies to the
   * executor chosen here; an injected `executor` owns its own budget.
   */
  timeoutMs?: number;
  /** Hosts the connector may reach, in the shared egress grammar. Unset is
   *  unrestricted; an EMPTY list denies everything. */
  allowedDomains?: readonly string[];
}): Promise<ExecutorResult> {
  const executor =
    params.executor ??
    (await selectExecutor({ timeoutMs: params.timeoutMs, allowedDomains: params.allowedDomains }));
  return executor.execute(params.compiledCode, params.job, params.hooks);
}
