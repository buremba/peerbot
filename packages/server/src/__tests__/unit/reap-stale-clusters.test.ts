/**
 * Unit test for the orphaned-cluster reaper (embedded-postgres-backend).
 *
 * Killed test runs (SIGKILL / timeout / OOM / ENOSPC) skip teardown and leak
 * their `lobu-test-pg-*` data dir to tmp; a session of them once filled 65 GB.
 * The reaper removes clusters older than the staleness threshold at the start of
 * every embedded-PG start, so a kill can never accumulate. This pins that logic.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

/**
 * A PID that is reliably dead across runtimes: spawn a process to completion
 * (spawnSync reaps it), so its PID is freed. More portable than a magic
 * out-of-range number, which `process.kill(pid, 0)` handles inconsistently
 * (node throws ESRCH; bun can report it as alive).
 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid ?? 2147483646;
}
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reapStaleClustersIn, STALE_CLUSTER_MS } from '../setup/reap-stale-clusters';

describe('reapStaleClustersIn', () => {
  let root: string;
  const now = Date.now();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'reaper-test-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Writing the pid file must happen BEFORE utimesSync — creating a file inside
  // the dir bumps the dir's mtime, which would otherwise make a "stale" dir look
  // fresh and the reaper would skip it.
  function makeDir(name: string, ageMs: number, pid?: number): string {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    if (pid !== undefined) writeFileSync(join(p, 'postmaster.pid'), `${pid}\n/some/data\n`);
    const t = (now - ageMs) / 1000; // utimes wants seconds
    utimesSync(p, t, t);
    return p;
  }

  it('removes only stale lobu-test-pg-* dirs, keeps fresh and non-matching', () => {
    const stale = makeDir('lobu-test-pg-OLD', STALE_CLUSTER_MS + 60_000);
    const fresh = makeDir('lobu-test-pg-NEW', 5_000); // 5s old — active
    const other = makeDir('some-other-dir', STALE_CLUSTER_MS + 60_000); // not ours

    const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false); // reaped
    expect(existsSync(fresh)).toBe(true); // too young — a possibly-active run
    expect(existsSync(other)).toBe(true); // wrong prefix — never touched
  });

  it('keeps an OLD cluster that is still running (live postmaster.pid)', () => {
    // A long watch/CI run can outlive the staleness window — its data dir must
    // never be reaped while the cluster is alive (the review blocker).
    const live = makeDir('lobu-test-pg-LIVE', STALE_CLUSTER_MS + 60_000, process.pid); // our own live PID
    const deadOwner = makeDir('lobu-test-pg-DEAD', STALE_CLUSTER_MS + 60_000, deadPid()); // reaped PID

    const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

    expect(existsSync(live)).toBe(true); // live owner → never reaped, despite age
    expect(existsSync(deadOwner)).toBe(false); // stale pid file, process gone → reaped
    expect(removed).toBe(1);
  });

  it('is a no-op on a missing directory (never throws)', () => {
    expect(reapStaleClustersIn(join(root, 'does-not-exist'), now, STALE_CLUSTER_MS)).toBe(0);
  });
});
