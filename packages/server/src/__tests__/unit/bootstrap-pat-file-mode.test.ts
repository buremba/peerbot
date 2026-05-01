/**
 * Bootstrap PAT file mode contract.
 *
 * `start-local.ts` writes the bootstrap PAT to ${OWLETTO_DATA_DIR}/bootstrap-pat.txt
 * with `writeFileSync(..., { mode: 0o600 })` so the token can't be read by
 * other local users on shared machines. This test pins the contract:
 *
 *   - the source line that writes the file uses `mode: 0o600`
 *   - a writeFileSync call with `{ mode: 0o600 }` actually produces a file
 *     whose permission bits are exactly `0o600` on the local filesystem
 *
 * The first check guards against accidental edits that drop the mode option;
 * the second ensures Node's writeFileSync honors the option on this OS.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('bootstrap PAT file mode', () => {
  it('start-local.ts writes the PAT with mode: 0o600', () => {
    const source = readFileSync(
      new URL('../../start-local.ts', import.meta.url),
      'utf8'
    );
    // The single writeFileSync call for the PAT file. If the call shape changes
    // (for example, a refactor extracts it into a helper), update both this
    // pin AND the on-disk mode assertion below.
    expect(source).toContain('writeFileSync(patFilePath, `${token}\\n`, { mode: 0o600 })');
  });

  it('writeFileSync with mode 0o600 yields permission bits 0o600', () => {
    // On Windows, `mode` is largely advisory. The bootstrap path is dev-only
    // and used by scripts/e2e-lobu-apply.sh on macOS/Linux, so a Windows skip
    // is acceptable; the suite is currently macOS-first.
    if (process.platform === 'win32') return;

    const dir = mkdtempSync(join(tmpdir(), 'owletto-bootstrap-pat-'));
    const file = join(dir, 'bootstrap-pat.txt');
    writeFileSync(file, 'owl_pat_test\n', { mode: 0o600 });
    const observed = statSync(file).mode & 0o777;
    expect(observed).toBe(0o600);
  });
});
