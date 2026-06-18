/**
 * Boot-time Node.js version assertion.
 *
 * Lobu's SDK sandbox (query_sdk / run_sdk) depends on isolated-vm, whose native
 * addon is tied to the V8 ABI of each Node line. We ship two builds side by side
 * (see optionalDependencies): `isolated-vm@6` covers Node 22–24, and the aliased
 * `isolated-vm-next` (isolated-vm@7) covers Node 26+. Node 25 is an EOL,
 * odd-numbered non-LTS line that upstream skipped entirely (issue #553 went
 * straight from 24 to 26), so the sandbox is unavailable there.
 *
 * The runtime loader (`run-script.ts` `loadIsolatedVm`) picks the right build per
 * Node major and degrades to RuntimeUnavailable if neither loads. So Lobu BOOTS on
 * any Node >= 22; we only hard-fail below 22, and warn on 25 where the sandbox
 * can't load — keeping the diagnostic close to the cause instead of surfacing
 * hours later when an agent first invokes the sandbox.
 */

const SUPPORTED_NODE_MAJOR_MIN = 22;
const SANDBOX_GAP_NODE_MAJOR = 25;

function sandboxAvailableForNode(major: number): boolean {
  // isolated-vm@6 → 22–24; isolated-vm@7 (isolated-vm-next) → 26+. 25 has neither.
  return (major >= SUPPORTED_NODE_MAJOR_MIN && major < SANDBOX_GAP_NODE_MAJOR) || major >= 26;
}

function assertSupportedNodeVersion(): void {
  const current = process.versions.node;
  const major = Number(current?.split('.')[0] ?? 0);

  if (!Number.isFinite(major) || major < SUPPORTED_NODE_MAJOR_MIN) {
    const message = [
      `Lobu requires Node.js ${SUPPORTED_NODE_MAJOR_MIN} or newer. Detected ${current}.`,
      'Fix: install Node 22+ (e.g. `brew install node@22`, then `PATH=/opt/homebrew/opt/node@22/bin:$PATH make dev`)',
      'or use a version manager that honours .nvmrc/.node-version (nvm, fnm, mise, asdf, volta).',
    ].join('\n  ');
    throw new Error(`Unsupported Node.js runtime.\n  ${message}`);
  }

  if (!sandboxAvailableForNode(major)) {
    // Node 25: boot, but the SDK sandbox (query_sdk / run_sdk) won't be available.
    console.warn(
      [
        `[lobu] Node ${current} detected: the SDK sandbox (query_sdk / run_sdk) is unavailable.`,
        'isolated-vm has no build for Node 25 (an EOL non-LTS line upstream skipped).',
        'The rest of Lobu runs normally. For the sandbox, use Node 24 (LTS) or 26+.',
      ].join('\n  '),
    );
  }
}

// Run on module load so a single side-effect import at the top of an entry
// file fires the check BEFORE any other static import executes. ESM evaluates
// sibling imports in textual order; placing this module's import first
// guarantees the assertion runs before instrument.ts, dotenv, embedded-postgres, etc.
assertSupportedNodeVersion();
