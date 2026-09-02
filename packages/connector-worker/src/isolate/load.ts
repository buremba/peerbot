/**
 * Load `isolated-vm` for the Node line this worker runs on.
 *
 * The native addon is ABI-bound per Node major, so two builds ship as
 * optionalDependencies: `isolated-vm@6` for Node 22–24 and the aliased
 * `isolated-vm-next` (= `isolated-vm@7`) for Node 26+. Node 25 is an EOL
 * non-LTS line upstream skipped, and Bun cannot dlopen a V8 addon at all.
 * Both return `null` so the caller fails closed (the executor selector falls
 * back to the process lane and says so once). Mirrors
 * `packages/server/src/sandbox/run-script.ts`; the gateway adopting this
 * module is a follow-up.
 */

import type { IsolatedVm } from './ivm-types.js';

interface IsolatedVmModuleShape {
  default?: unknown;
  'module.exports'?: unknown;
}

function unwrapIsolatedVm(mod: unknown): IsolatedVm {
  const m = mod as IsolatedVmModuleShape;
  return (m.default ?? m['module.exports'] ?? m) as IsolatedVm;
}

function isBun(): boolean {
  return typeof (process.versions as { bun?: string }).bun === 'string';
}

function nodeMajor(): number {
  return Number(process.versions.node?.split('.')[0] ?? 0);
}

/**
 * Why this host cannot run an isolate, or `null` when the Node line has a
 * build. A load failure on an eligible line (native build skipped on this
 * platform) is reported by `loadIsolatedVm()` returning null; this only
 * classifies the runtime.
 */
export function isolatedVmUnavailableReason(): string | null {
  if (isBun()) {
    return `isolated-vm is a V8 native addon and cannot load under Bun ${process.versions.bun}`;
  }
  const major = nodeMajor();
  if (!Number.isFinite(major) || major === 0) return 'could not determine the Node major version';
  if (major < 22) return `isolated-vm needs Node 22+; this host runs Node ${process.versions.node}`;
  if (major === 25) return 'isolated-vm has no build for Node 25 (EOL non-LTS line skipped upstream)';
  return null;
}

let cached: Promise<IsolatedVm | null> | null = null;

/**
 * Resolve the isolated-vm module for this Node line, or `null` when it cannot
 * load. Memoized per process: the addon is loaded once and shared by every
 * isolate the worker creates.
 */
export function loadIsolatedVm(): Promise<IsolatedVm | null> {
  if (!cached) cached = loadIsolatedVmUncached();
  return cached;
}

async function loadIsolatedVmUncached(): Promise<IsolatedVm | null> {
  if (isolatedVmUnavailableReason() !== null) return null;
  const major = nodeMajor();
  try {
    // Dynamic on purpose: the two builds are optionalDependencies gated by
    // Node major, and a static import of a native addon absent on this host
    // would fail this module (and every static importer of the executor) at
    // load instead of failing closed for the isolate lane alone.
    if (major >= 22 && major < 25) {
      return unwrapIsolatedVm(await import('isolated-vm'));
    }
    if (major >= 26) {
      return unwrapIsolatedVm(await import('isolated-vm-next'));
    }
    return null;
  } catch {
    return null;
  }
}
