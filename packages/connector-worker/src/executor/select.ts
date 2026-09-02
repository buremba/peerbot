/**
 * Executor selection by execution lane.
 *
 * `lane: 'isolate'` is a requirement, not a preference: the gateway sets it
 * for organization-supplied code whose security boundary IS the isolate, so a
 * host that cannot run one must fail the run loudly rather than hand the code
 * to a forked child with real credentials and open sockets. Jobs without a
 * lane (or `lane: 'process'`) run on the process lane exactly as before.
 */

import type { ExecutionLane } from '@lobu/core/contracts/worker/protocol';
import { isolatedVmUnavailableReason, loadIsolatedVm } from '../isolate/load.js';
import type { SyncExecutor } from './interface.js';
import { IsolateExecutor, type IsolateExecutorOptions, IsolateRuntimeUnavailableError } from './isolate.js';
import { SubprocessExecutor } from './subprocess.js';

export interface ExecutorSelection {
  lane?: ExecutionLane | null;
  /** Wall-clock budget for the run; `0` disables it. Unset keeps each executor's default. */
  timeoutMs?: number;
  /** Process lane: child `--max-old-space-size` in MB. Unset keeps the default. */
  maxOldSpaceSize?: number;
  /** Isolate lane: V8 heap limit in MB. Unset keeps the default (512). */
  memoryMb?: number;
  /** Isolate lane: hosts the connector may fetch. Unset or empty closes egress. */
  allowedDomains?: readonly string[];
  /** Isolate lane: console sink override (tests). */
  logSink?: IsolateExecutorOptions['logSink'];
}

/**
 * Pick the executor for a job. Rejects with `IsolateRuntimeUnavailableError`
 * when the job requires the isolate lane and this host cannot load
 * `isolated-vm` (Bun, Node 25, or a failed native build); no child process is
 * spawned in that case.
 */
export async function selectExecutor(selection: ExecutorSelection): Promise<SyncExecutor> {
  if (selection.lane === 'isolate') {
    const ivm = await loadIsolatedVm();
    if (!ivm) throw new IsolateRuntimeUnavailableError(isolatedVmUnavailableReason());
    const options: Partial<IsolateExecutorOptions> = {};
    if (selection.timeoutMs !== undefined) options.timeoutMs = selection.timeoutMs;
    if (selection.memoryMb !== undefined) options.memoryMb = selection.memoryMb;
    if (selection.allowedDomains !== undefined) options.allowedDomains = selection.allowedDomains;
    if (selection.logSink !== undefined) options.logSink = selection.logSink;
    return new IsolateExecutor(options);
  }
  // Pass no options object at all when nothing is set: SubprocessExecutor
  // spreads over its defaults, so an explicit `undefined` would clobber them.
  const options: { timeoutMs?: number; maxOldSpaceSize?: number } = {};
  if (selection.timeoutMs !== undefined) options.timeoutMs = selection.timeoutMs;
  if (selection.maxOldSpaceSize !== undefined) options.maxOldSpaceSize = selection.maxOldSpaceSize;
  return Object.keys(options).length > 0 ? new SubprocessExecutor(options) : new SubprocessExecutor();
}
