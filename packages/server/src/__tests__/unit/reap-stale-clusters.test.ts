/**
 * Unit test for the orphaned-cluster reaper (embedded-postgres-backend).
 *
 * Killed test runs (SIGKILL / timeout / OOM / ENOSPC) skip teardown and leak
 * their `lobu-test-pg-*` data dir to tmp; a session of them once filled 65 GB.
 * The reaper removes clusters older than the staleness threshold at the start of
 * every embedded-PG start, so a kill can never accumulate. This pins that logic.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  reapStaleClustersIn,
  STALE_CLUSTER_MS,
} from '../setup/embedded-postgres-backend';

describe('reapStaleClustersIn', () => {
  let root: string;
  const now = Date.now();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'reaper-test-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeDir(name: string, ageMs: number): string {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
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

  it('is a no-op on a missing directory (never throws)', () => {
    expect(reapStaleClustersIn(join(root, 'does-not-exist'), now, STALE_CLUSTER_MS)).toBe(0);
  });
});
