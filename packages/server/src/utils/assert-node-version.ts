/**
 * Boot-time Node.js version assertion.
 *
 * Lobu's SDK sandbox (query_sdk / run_sdk) depends on isolated-vm@6, which has not
 * shipped Node 25+ support yet — upstream is tracking it as
 * https://github.com/laverdet/isolated-vm/issues/553. On Node 26 the addon fails
 * to dlopen ("symbol not found: v8::ArrayBuffer::Allocator::Reallocate"), and on
 * Node 25 the upstream comment says it crashes on isolate construction.
 *
 * `packages/server/src/sandbox/run-script.ts:170` already short-circuits the call
 * site to `RuntimeUnavailable`, but that surfaces hours after `make dev` when an
 * agent finally invokes the sandbox. Failing fast at boot keeps the diagnostic
 * close to the cause.
 */

const SUPPORTED_NODE_MAJOR_MIN = 22;
const SUPPORTED_NODE_MAJOR_MAX_EXCLUSIVE = 25;

export function assertSupportedNodeVersion(): void {
  const current = process.versions.node;
  const major = Number(current?.split('.')[0] ?? 0);
  if (
    !Number.isFinite(major) ||
    major < SUPPORTED_NODE_MAJOR_MIN ||
    major >= SUPPORTED_NODE_MAJOR_MAX_EXCLUSIVE
  ) {
    const supported = `${SUPPORTED_NODE_MAJOR_MIN}.x – ${SUPPORTED_NODE_MAJOR_MAX_EXCLUSIVE - 1}.x`;
    const message = [
      `Lobu requires Node.js ${supported}. Detected ${current}.`,
      'Reason: isolated-vm (used by the query_sdk / run_sdk sandbox) does not yet support Node 25+.',
      'Tracking upstream: https://github.com/laverdet/isolated-vm/issues/553',
      'Fix: install Node 22 (e.g. `brew install node@22`, then `PATH=/opt/homebrew/opt/node@22/bin:$PATH make dev`)',
      'or use a version manager that honours .nvmrc/.node-version (nvm, fnm, mise, asdf, volta).',
    ].join('\n  ');
    throw new Error(`Unsupported Node.js runtime.\n  ${message}`);
  }
}

// Run on module load so a single side-effect import at the top of an entry
// file fires the check BEFORE any other static import executes. ESM evaluates
// sibling imports in textual order; placing this module's import first
// guarantees the assertion runs before instrument.ts, dotenv, pglite, etc.
assertSupportedNodeVersion();
