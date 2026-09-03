/**
 * Executor selection: all connectors execute inside a hardened V8 isolate (IsolateExecutor).
 */

import type { ExecutionLane } from '@lobu/core/contracts/worker/protocol';
import { isolatedVmUnavailableReason, loadIsolatedVm } from '../isolate/load.js';
import type { SyncExecutor } from './interface.js';
import { IsolateExecutor, type IsolateExecutorOptions, IsolateRuntimeUnavailableError } from './isolate.js';

export interface ExecutorSelection {
  lane?: ExecutionLane | null;
  /** Wall-clock budget for the run; `0` disables it. Unset keeps default (600s). */
  timeoutMs?: number;
  /** V8 heap limit in MB. Unset keeps the default (512). */
  memoryMb?: number;
  /** Hosts the connector may fetch. Unset or empty uses default egress. */
  allowedDomains?: readonly string[];
  /** Console sink override (tests). */
  logSink?: IsolateExecutorOptions['logSink'];
}

/**
 * Pick the executor for a job. Connectors execute on the isolate lane.
 * Rejects with `IsolateRuntimeUnavailableError` when this host cannot load
 * `isolated-vm` (Bun, Node 25, or a failed native build).
 */
export async function selectExecutor(selection: ExecutorSelection = {}): Promise<SyncExecutor> {
  const ivm = await loadIsolatedVm();
  if (!ivm) throw new IsolateRuntimeUnavailableError(isolatedVmUnavailableReason());
  const options: Partial<IsolateExecutorOptions> = {};
  if (selection.timeoutMs !== undefined) options.timeoutMs = selection.timeoutMs;
  if (selection.memoryMb !== undefined) options.memoryMb = selection.memoryMb;
  if (selection.allowedDomains !== undefined) options.allowedDomains = selection.allowedDomains;
  if (selection.logSink !== undefined) options.logSink = selection.logSink;
  return new IsolateExecutor(options);
}
