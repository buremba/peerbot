/**
 * Unit test for the orphaned-cluster reaper (embedded-postgres-backend).
 *
 * Killed test runs (SIGKILL / timeout / OOM / ENOSPC) skip teardown and leak
 * their `lobu-test-pg-*` data dir to tmp; a session of them once filled 65 GB.
 * The first embedded-PG start in each test process reaps old clusters left by
 * previous killed runs. This pins that logic.
 */

import { spawn, spawnSync } from 'node:child_process';
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

  it('treats a malformed PID line as having no live owner', () => {
    const path = makeDir('lobu-test-pg-MALFORMED', STALE_CLUSTER_MS + 60_000);
    writeFileSync(join(path, 'postmaster.pid'), `${process.pid}junk\n`);
    const t = (now - STALE_CLUSTER_MS - 60_000) / 1000;
    utimesSync(path, t, t);

    expect(reapStaleClustersIn(root, now, STALE_CLUSTER_MS)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  describe('orphaned postmaster (reparented to PID 1)', () => {
    const spawned = new Set<number>();

    function postmasterArgs(dataDir: string): string[] {
      return ['-e', 'setInterval(() => {}, 1000)', '--', '-D', dataDir];
    }

    /**
     * Start a process that outlives its own parent, so the kernel reparents it to
     * PID 1 — the normal result for an embedded-postgres postmaster whose test
     * runner is SIGKILLed. The short-lived Node parent exits after printing the
     * child PID, and spawnSync waits for that exit, so reparenting has happened
     * by the time this returns.
     */
    function orphanPostmaster(dataDir: string): number {
      const parent = `
        const { spawn } = require('node:child_process');
        const child = spawn(
          ${JSON.stringify(process.execPath)},
          ${JSON.stringify(postmasterArgs(dataDir))},
          { argv0: 'postgres', detached: true, stdio: 'ignore' },
        );
        child.unref();
        process.stdout.write(String(child.pid));
      `;
      const r = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8' });
      const pid = Number.parseInt((r.stdout ?? '').trim(), 10);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      spawned.add(pid);
      return pid;
    }

    /**
     * A stale cluster dir whose `postmaster.pid` names a live orphan.
     *
     * The fake exposes the `postgres` executable name and exact `-D <dir>`
     * arguments that the reaper requires. Its pid file records the requested
     * start time on line three, matching PostgreSQL's format.
     */
    function makeOrphanDir(
      name: string,
      ageMs: number,
      processDataDir: (dir: string) => string = (dir) => dir,
    ) {
      const p = join(root, name);
      const pidFile = join(p, 'postmaster.pid');
      mkdirSync(p, { recursive: true });
      const pid = orphanPostmaster(processDataDir(p));
      const t = (now - ageMs) / 1000;
      writeFileSync(pidFile, `${pid}\n${p}\n${Math.floor(t)}\n`);
      return { path: p, pid };
    }

    function isLive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    }

    /**
     * Still genuinely RUNNING — not merely a PID the kernel still answers for.
     *
     * A signalled direct child of this process becomes a zombie until it is
     * waited on, and `kill(pid, 0)` succeeds for a zombie. Asserting protection
     * with `isLive` alone therefore passes even when the process was killed,
     * which silently hid whether the owned-cluster guard fired at all. `ps`
     * reports state `Z` for a zombie, so exclude it.
     */
    function isRunning(pid: number): boolean {
      const r = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
      if (r.status !== 0 || typeof r.stdout !== 'string') return false;
      const state = r.stdout.trim();
      return state.length > 0 && !state.startsWith('Z');
    }

    /** Poll briefly because signal delivery and process teardown are asynchronous. */
    function waitGone(pid: number): boolean {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!isLive(pid)) return true;
        spawnSync('sleep', ['0.05']);
      }
      return false;
    }

    afterAll(() => {
      for (const pid of spawned) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already reaped by the code under test — that is the point
        }
      }
    });

    it('stops and removes an old cluster whose owner is gone', () => {
      // A bare liveness probe sees a live postmaster and otherwise preserves an
      // abandoned cluster at any age.
      const { path, pid } = makeOrphanDir('lobu-test-pg-ORPHAN', STALE_CLUSTER_MS + 60_000);
      expect(isRunning(pid)).toBe(true); // precondition: it really is running

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(1);
      expect(existsSync(path)).toBe(false);
      expect(waitGone(pid)).toBe(true); // stopped, not just unlinked
      spawned.delete(pid);
    });

    it('keeps a young orphan (a run that just started and lost its parent)', () => {
      const { path, pid } = makeOrphanDir('lobu-test-pg-YOUNGORPHAN', 5_000);

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(isRunning(pid)).toBe(true); // never signalled
    });

    it('never touches an old cluster whose postmaster still has a live parent', () => {
      // The realistic form of the protection above: a process that passes the
      // postmaster executable/data-dir identity check but whose owning run is
      // still alive. A long watch or CI run can outlive the staleness window,
      // and pulling its database out from under it breaks that run. This is the
      // test that fails if the PPID check is dropped.
      const p = join(root, 'lobu-test-pg-OWNED');
      const pidFile = join(p, 'postmaster.pid');
      mkdirSync(p, { recursive: true });
      // A DIRECT child, so its PPID is this test process, not 1.
      const child = spawn(process.execPath, postmasterArgs(p), {
        argv0: 'postgres',
        stdio: 'ignore',
      });
      const pid = child.pid;
      expect(pid).toBeGreaterThan(0);
      if (pid !== undefined) spawned.add(pid);
      writeFileSync(
        pidFile,
        `${pid}\n${p}\n${Math.floor((now - STALE_CLUSTER_MS - 60_000) / 1000)}\n`,
      );

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(p)).toBe(true);
      expect(isRunning(pid as number)).toBe(true);
      child.kill('SIGKILL');
      if (pid !== undefined) spawned.delete(pid);
    });

    it('never signals a PID whose data-dir argument merely shares the cluster prefix', () => {
      // `postmaster.pid` is a plain file left behind by a crash: the OS can have
      // reassigned that number to an unrelated process. Signalling it would kill
      // somebody else's work, so a different exact `-D` argument must not match.
      const { path, pid } = makeOrphanDir(
        'lobu-test-pg-RECYCLED',
        STALE_CLUSTER_MS + 60_000,
        (dir) => `${dir}-other`,
      );

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(isRunning(pid)).toBe(true);
    });

    it('keeps a live orphan when its recorded start time is invalid', () => {
      const { path, pid } = makeOrphanDir('lobu-test-pg-NOSTART', STALE_CLUSTER_MS + 60_000);
      writeFileSync(join(path, 'postmaster.pid'), `${pid}\n${path}\nnot-a-time\n`);

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(isRunning(pid)).toBe(true);
    });
  });
});
