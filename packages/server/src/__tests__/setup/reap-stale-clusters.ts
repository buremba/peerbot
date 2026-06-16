/**
 * Pure, side-effect-free reaper for orphaned embedded-Postgres test clusters.
 *
 * Killed test runs (SIGKILL / timeout / OOM / ENOSPC / `pkill`) skip teardown
 * and leak their `lobu-test-pg-*` data dir (~150-400 MB) to tmp; a session of
 * them once filled 65 GB. `startEmbeddedBackend()` calls this before creating
 * its own cluster, so a kill can never accumulate.
 *
 * Deliberately imports ONLY node:fs/path — no `embedded-postgres` — so the
 * no-database unit suite can import and test it without pulling the native
 * embedded-Postgres package (the reason this lives in its own module).
 */

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 1h — far longer than any integration run, so an *idle* hit is orphaned. */
export const STALE_CLUSTER_MS = 60 * 60 * 1000;

/**
 * True if `dir` holds a running Postgres: a `postmaster.pid` whose PID is a live
 * process. embedded-postgres writes this on start and removes it on clean stop,
 * so it's the authoritative "is this cluster in use" marker — never reap a dir
 * with a live owner, regardless of age (a long watch/CI run can exceed 1h).
 */
export function clusterIsLive(dir: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(join(dir, 'postmaster.pid'), 'utf8').split('\n', 1)[0], 10);
  } catch {
    return false; // no pid file → cleanly stopped or never started
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe; throws if the PID is gone
    return true;
  } catch (err) {
    // ESRCH → process gone (dead, safe to reap). EPERM → exists but not ours
    // (another user's live cluster) → treat as live, do not reap.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove `lobu-test-pg-*` dirs under `dir` that are both older than `staleMs`
 * (relative to `now`) AND have no live Postgres owner. The liveness gate means a
 * still-running cluster is never deleted even if it has outlived the staleness
 * window. Returns how many were removed.
 */
export function reapStaleClustersIn(dir: string, now: number, staleMs: number): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith('lobu-test-pg-')) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs <= staleMs) continue; // too young — maybe active
      if (clusterIsLive(path)) continue; // running owner — never reap, any age
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Racing another run's own cleanup, or a permission quirk — ignore.
    }
  }
  return removed;
}
