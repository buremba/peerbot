/**
 * Dependency-light reaper for orphaned embedded-Postgres test clusters.
 *
 * Killed test runs (SIGKILL / timeout / OOM / ENOSPC / `pkill`) skip teardown
 * and leak their `lobu-test-pg-*` data dir (~150-400 MB) to tmp; a session of
 * them once filled 65 GB. `startEmbeddedBackend()` calls this before creating
 * its first cluster in each test process, so old leaks are reclaimed by a later
 * run.
 *
 * Deliberately imports ONLY node:fs/path/child_process — no `embedded-postgres`
 * — so the no-database unit suite can import and test it without pulling the
 * native embedded-Postgres package (the reason this lives in its own module).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Grace period before an unowned cluster is eligible for removal. 1h is far
 * longer than any integration run, so a cluster idle for that long is orphaned.
 */
export const STALE_CLUSTER_MS = 60 * 60 * 1000;

/** Postmaster PID recorded in `dir`, or null when there is no usable pid file. */
function postmasterPid(dir: string): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(join(dir, 'postmaster.pid'), 'utf8').split('\n', 1)[0]);
  } catch {
    return null; // no pid file → cleanly stopped or never started
  }
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** True if `pid` is a live process, treating EPERM (not ours) as live. */
function pidIsLive(pid: number): boolean {
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
 * True when a live postmaster has no owner left to stop it.
 *
 * embedded-postgres starts the server with `spawn(postgres, ...)` — a DIRECT
 * child, not a daemonising `pg_ctl start` — so the postmaster's parent is the
 * test process itself. When that process dies without teardown the kernel
 * normally reparents the postmaster to init/launchd, i.e. PPID becomes 1. Such
 * a cluster is genuinely abandoned, but a bare liveness probe reports it as in
 * use and used to preserve it indefinitely — eight were found running on one
 * developer machine, the oldest for three days, each holding its data dir.
 *
 * Outside the PID-1 runner case below, a concurrently running test's postmaster
 * retains that runner as its parent and stays protected.
 *
 * Fails CLOSED — any doubt reports "owned", because wrongly reaping a live
 * test's database breaks that run, while missing an orphan only costs disk that
 * the next start will reconsider:
 *   - `process.pid === 1`: some containers run the test runner as init, which
 *     would make every healthy child look orphaned.
 *   - `ps` missing, failing, or printing something unparseable.
 */
function ownerIsGone(pid: number): boolean {
  if (process.pid === 1) return false;
  if (pid === process.pid || pid === process.ppid) return false; // never target ourselves
  try {
    const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return false;
    const ppid = Number(result.stdout.trim());
    return Number.isInteger(ppid) && ppid === 1;
  } catch {
    return false;
  }
}

/**
 * True only if `pid` really is the postmaster for `dir`.
 *
 * `postmaster.pid` is a stale file on disk: after a crash the number in it can
 * belong to an entirely unrelated process the OS has since assigned that PID to.
 * The dead-owner path never cared, because it only ever deleted a directory —
 * but the orphan path signals it, so acting on a recycled PID would kill
 * somebody else's process. Require both the postgres executable and an exact
 * `-D <dir>` argument; embedded-postgres starts the postmaster as
 * `postgres -D <dir> -p <port>`.
 *
 * Fails CLOSED: no `ps`, non-zero exit, or no match means "do not signal".
 */
function pidIsPostmasterFor(pid: number, dir: string): boolean {
  try {
    const result = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return false;
    const command = result.stdout.trim();
    const escapedDir = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      /(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/.test(command) &&
      new RegExp(`(?:^|\\s)-D\\s+${escapedDir}(?:\\s|$)`).test(command)
    );
  } catch {
    return false;
  }
}

/**
 * Start time recorded on line three of `postmaster.pid`, in Unix seconds. The
 * directory mtime cannot age a running cluster: an orphan still checkpoints and
 * cycles WAL segments, refreshing the directory indefinitely.
 */
function clusterStartedMs(dir: string): number | null {
  try {
    const seconds = Number(readFileSync(join(dir, 'postmaster.pid'), 'utf8').split('\n')[2]);
    return Number.isInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Stop an abandoned postmaster, returning false unless it is safe to remove its
 * data dir.
 *
 * The ONLY code here that signals a process, so it is where identity is
 * established: a live PID is signalled only once it is confirmed both ownerless
 * (PPID 1) and really this cluster's postmaster. Anything unconfirmed returns
 * false and the caller leaves the directory alone.
 */
function stopOrphanedPostmaster(pid: number, dir: string): boolean {
  if (!pidIsLive(pid)) return true;
  if (!ownerIsGone(pid) || !pidIsPostmasterFor(pid, dir)) return false;
  try {
    process.kill(pid, 'SIGINT'); // PostgreSQL fast shutdown, matching embedded-postgres.stop()
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!pidIsLive(pid)) return true;
    spawnSync('sleep', ['0.1']);
  }

  // Recheck both ownership and identity before escalating: the old process may
  // have exited and its PID may now belong to a new, owned postmaster.
  if (!ownerIsGone(pid) || !pidIsPostmasterFor(pid, dir)) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Remove `lobu-test-pg-*` dirs under `dir` that are older than `staleMs`
 * (relative to `now`) and are not in use by a running test.
 *
 * Two ways a cluster qualifies:
 *   - its postmaster is dead (crashed or killed), or
 *   - its postmaster is alive but reparented to PID 1, so the run that owned it
 *     is gone. That one is stopped first, then removed.
 *
 * A cluster whose postmaster is alive under a live parent is never touched, at
 * any age, so a long watch/CI run cannot have its database pulled out from
 * under it. Returns how many were removed.
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
      const pid = postmasterPid(path);

      if (pid !== null && pidIsLive(pid)) {
        // Something is alive behind this pid file, so default to PROTECTING it:
        // the cost of a wrong "reap" is a running test losing its database, the
        // cost of a wrong "keep" is disk the next start reconsiders.
        //
        // Age it off its own start time, and let `stopOrphanedPostmaster` be the
        // single place that decides whether this really is an abandoned
        // postmaster — it is the only code that signals, so the identity checks
        // belong there rather than duplicated here.
        const started = clusterStartedMs(path);
        if (started === null || now - started <= staleMs) continue; // unknown/young → protect
        if (!stopOrphanedPostmaster(pid, path)) continue; // unconfirmed or still up
      } else if (now - statSync(path).mtimeMs <= staleMs) {
        continue; // no live owner, but too young — maybe a run just starting
      }

      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Racing another run's own cleanup, or a permission quirk — ignore.
    }
  }
  return removed;
}
