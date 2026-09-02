/**
 * Connector isolate lane: host bridge, guest prelude and eligibility.
 *
 * `IsolateExecutor` (`executor/isolate.ts`) composes these into the
 * `SyncExecutor` contract; this subpath exposes the building blocks so the
 * gateway can adopt the same bridge for its own isolate runner later.
 */

export { assertIsolateEligible, findIsolateIneligibleBuiltins, IsolateLaneIneligibleError, isNodeBuiltinSpecifier } from './eligibility.js';
export {
  IsolateHost,
  IsolateHostError,
  type HostAsyncCapability,
  type HostSyncCapability,
  type IsolateFailureKind,
  type IsolateHostOptions,
  type IsolateRunOptions,
  type IsolateTerminalState,
} from './bridge.js';
export type { IsolatedVm, IvmHeapStatistics } from './ivm-types.js';
export { isolatedVmUnavailableReason, loadIsolatedVm } from './load.js';
export { GUEST_PRELUDE, PRELUDE_GLOBALS } from './prelude.js';
