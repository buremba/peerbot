/**
 * OS process supervision for the device Automation arm.
 *
 * Kept separate from automation.ts so spawn/heartbeat/resume policy does not
 * share a control-flow surface with POSIX group ownership and Windows tree
 * termination.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const SUPPORTS_PROCESS_GROUPS = process.platform !== 'win32';
const TREE_TERM_GRACE_MS = 3000;
const PROCESS_REAP_GRACE_MS = 5000;
/** Bounds one `ps` snapshot without trusting a partial process table. */
const PS_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Keep a process-group leader alive after the actual CLI exits. The daemon can
 * then clean up descendants through an identity that the kernel cannot recycle
 * underneath it. The supervisor deliberately ignores SIGTERM; the CLI and its
 * descendants still receive the group signal, while the supervisor remains the
 * ownership anchor until the daemon releases or SIGKILLs it.
 *
 * POSIX caller contract: serialize and spawn this closure-free function with
 * `detached: true`, making the supervisor the session/process-group leader
 * whose pgid equals its pid. Its parent-loss path uses that invariant for safe
 * negative-pid group signals.
 */
function runCliSupervisor(spawnChild: typeof spawn, treeTermGraceMs: number): void {
  const [binary, ...args] = process.argv.slice(1);
  let targetFinished = false;
  let parentLost = false;
  let target: ChildProcess | undefined;
  const keepAlive = setInterval(() => {}, 2147483647);
  const send = (message: Record<string, unknown>) => {
    try { process.send?.(message); } catch {}
  };
  const finish = (
    code: number | null,
    signal: NodeJS.Signals | null,
    error: string | null
  ) => {
    if (targetFinished) return;
    targetFinished = true;
    if (!parentLost) send({ type: 'target-exit', code, signal, error });
  };
  const stopAfterParentLoss = () => {
    if (parentLost) return;
    parentLost = true;
    clearInterval(keepAlive);

    if (process.platform === 'win32') {
      // Keep this process alive as the tree root until taskkill gets its chance.
      // The timer is deliberately ref'ed: parent loss must not let the supervisor
      // exit before the owned CLI tree has been addressed.
      try {
        const killer = spawnChild('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => {});
      } catch {}
      setTimeout(() => {
        try { target?.kill('SIGKILL'); } catch {}
        process.exit(1);
      }, treeTermGraceMs);
      return;
    }

    // This detached supervisor is still the live session/group leader, so its
    // own negative pid cannot have been recycled. Ignore SIGTERM here while the
    // target and descendants get a graceful window, then kill the complete group
    // including this anchor so parent loss cannot leave an immortal orphan.
    try {
      process.kill(-process.pid, 'SIGTERM');
    } catch {
      try { target?.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        try { target?.kill('SIGKILL'); } catch {}
        process.exit(1);
      }
    }, treeTermGraceMs);
  };
  process.on('SIGTERM', () => {});
  process.once('disconnect', stopAfterParentLoss);
  process.on('message', (message: unknown) => {
    if (
      typeof message !== 'object' ||
      message == null ||
      (message as Record<string, unknown>).type !== 'release' ||
      !targetFinished
    ) return;
    clearInterval(keepAlive);
    process.exit(0);
  });
  if (!binary) {
    finish(127, null, 'automation supervisor missing target binary');
  } else {
    try {
      target = spawnChild(binary, args, {
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      });
    } catch (error) {
      finish(127, null, error instanceof Error ? error.message : String(error));
    }
    target?.once('error', (error) => {
      finish(127, null, error instanceof Error ? error.message : String(error));
    });
    target?.once('exit', (code, signal) => finish(code, signal, null));
  }
  setImmediate(() => {
    if (!process.connected) stopAfterParentLoss();
  });
}

export const CLI_SUPERVISOR_SOURCE = `(${runCliSupervisor.toString()})(require('node:child_process').spawn, ${TREE_TERM_GRACE_MS});`;

interface TargetExit {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  error: string | null;
}

interface SupervisedCli {
  supervisor: ChildProcess;
  targetExit: Promise<TargetExit>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the supervised CLI to exit, the timeout to lapse, or cancellation. */
export function waitForTargetExit(
  targetExit: Promise<TargetExit>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{ timedOut: boolean; aborted: boolean; target?: TargetExit }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: {
      timedOut: boolean;
      aborted: boolean;
      target?: TargetExit;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => settle({ timedOut: false, aborted: true });
    const timer = setTimeout(() => {
      settle({ timedOut: true, aborted: false });
    }, timeoutMs);
    timer.unref?.();
    targetExit.then((target) => settle({ timedOut: false, aborted: false, target }));
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Await the target metadata after process-tree termination. */
export async function waitForTargetExitAfterTermination(
  targetExit: Promise<TargetExit>,
  timeoutMs = PROCESS_REAP_GRACE_MS
): Promise<TargetExit | null> {
  const { target } = await waitForTargetExit(targetExit, timeoutMs);
  return target ?? null;
}

/** Wait a bounded interval for a signal sent to the child to take effect. */
function waitForSignalledExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    proc.once('exit', onExit);
  });
}

type ProcessGroupOwner = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;

/**
 * Signal a POSIX group only while its supervisor is a live ownership anchor.
 * Once the anchor has exited, its numeric pid/pgid may refer to an unrelated
 * future process group and must never be used as a negative-pid signal target.
 * Exported only so the PID-reuse safety invariant has a direct regression test.
 */
export function signalOwnedPosixProcessGroup(
  owner: ProcessGroupOwner,
  signal: NodeJS.Signals,
  sendSignal: typeof process.kill = process.kill
): boolean {
  if (
    !SUPPORTS_PROCESS_GROUPS ||
    owner.pid == null ||
    owner.exitCode !== null ||
    owner.signalCode !== null
  ) {
    return false;
  }
  try {
    sendSignal(-owner.pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

/** Read a snapshot of one POSIX group without signalling its numeric id. */
function listPosixProcessGroupMembers(pgid: number): Promise<number[] | null> {
  const psBinary = existsSync('/bin/ps')
    ? '/bin/ps'
    : existsSync('/usr/bin/ps')
      ? '/usr/bin/ps'
      : 'ps';
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(psBinary, ['-axo', 'pid=,pgid='], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let output = '';
    const settle = (members: number[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(members);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(null);
    }, 1000);
    timer.unref?.();
    // A dropped chunk would silently shrink the member list, and an
    // undercount is exactly what makes releasing the anchor unsafe. Cap the
    // buffer, but treat hitting the cap as "no proof" rather than a short read.
    let truncated = false;
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      if (output.length + chunk.length > PS_OUTPUT_CAP_BYTES) {
        truncated = true;
        return;
      }
      output += chunk;
    });
    proc.once('error', () => settle(null));
    proc.once('close', (code) => {
      if (code !== 0 || truncated) {
        settle(null);
        return;
      }
      const members: number[] = [];
      for (const line of output.split('\n')) {
        const [pidText, pgidText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const rowPgid = Number(pgidText);
        if (Number.isInteger(pid) && rowPgid === pgid) members.push(pid);
      }
      settle(members);
    });
  });
}

/** Ask the supervisor to release its non-reusable group identity and reap it. */
export async function releaseSupervisor(proc: ChildProcess, timeoutMs = 1000): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  let sent = false;
  try {
    if (proc.connected) {
      proc.send?.({ type: 'release' });
      sent = true;
    }
  } catch {}
  if (sent && (await waitForSignalledExit(proc, timeoutMs))) return true;
  // Direct ChildProcess.kill uses the still-owned process handle; never turn a
  // failed release into a negative-pgid signal after the anchor might be gone.
  proc.kill('SIGKILL');
  await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
  return false;
}

/**
 * Wait until SIGTERM leaves only the supervisor in its group. Before releasing
 * the anchor, freeze the group and take a second snapshot so no live member can
 * fork across the observation. A process outside this new session cannot join
 * the group, so releasing the sole remaining supervisor is then race-free.
 */
export async function waitForOwnedPosixTreeToQuiesce(
  proc: ChildProcess,
  timeoutMs: number,
  listMembers: (pgid: number) => Promise<number[] | null> = listPosixProcessGroupMembers,
  wait: (ms: number) => Promise<void> = sleep
): Promise<boolean> {
  const pgid = proc.pid;
  if (pgid == null) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const members = await listMembers(pgid);
    if (members == null) {
      // An unavailable or overloaded `ps` removes our proof that only the
      // ownership anchor remains; it must not also remove the target's TERM
      // grace. Consume the remaining window, then escalate while the anchor is
      // still live and the negative pgid is still safe.
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) await wait(remainingMs);
      return false;
    }
    if (members.length === 1 && members[0] === pgid) {
      if (!signalOwnedPosixProcessGroup(proc, 'SIGSTOP')) return false;
      const frozenMembers = await listMembers(pgid);
      if (frozenMembers?.length === 1 && frozenMembers[0] === pgid) {
        if (!signalOwnedPosixProcessGroup(proc, 'SIGCONT')) return false;
        return releaseSupervisor(proc);
      }
      // The anchor is still live and stopped, so this cannot target a reused id.
      if (!signalOwnedPosixProcessGroup(proc, 'SIGCONT')) return false;
    }
    await wait(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return false;
}

/** Windows has no negative-pid process groups; taskkill supplies bounded tree cleanup. */
function taskkillWindowsTree(proc: ChildProcess, force: boolean): Promise<boolean> {
  if (proc.pid == null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const killer = spawn(
      'taskkill',
      ['/PID', String(proc.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true }
    );
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killer.kill();
      settle(false);
    }, 3000);
    timer.unref?.();
    killer.once('error', () => settle(false));
    killer.once('exit', (code) => settle(code === 0));
  });
}

/**
 * Keep the supervisor alive until Windows has had its forced tree-kill chance.
 * Killing only the supervisor after a failed graceful `taskkill /T` would
 * orphan the real CLI and make its numeric tree root unusable. Exported, with
 * its collaborators injectable, only so that ordering is testable off Windows.
 */
export async function terminateWindowsProcessTree(
  proc: ChildProcess,
  terminateTree: typeof taskkillWindowsTree = taskkillWindowsTree,
  waitForExit: typeof waitForSignalledExit = waitForSignalledExit
): Promise<'SIGTERM' | 'SIGKILL'> {
  const gracefulTreeKillSent = await terminateTree(proc, false);
  if (gracefulTreeKillSent && (await waitForExit(proc, TREE_TERM_GRACE_MS))) return 'SIGTERM';

  // If taskkill itself is unavailable, direct ChildProcess.kill remains the
  // best-effort fallback. It cannot guarantee cleanup of an already-orphaned
  // descendant, so use it only after the forced tree attempt has failed.
  if (!(await terminateTree(proc, true))) proc.kill('SIGKILL');
  await waitForExit(proc, PROCESS_REAP_GRACE_MS);
  return 'SIGKILL';
}

/**
 * Stop the complete CLI process tree, escalating to SIGKILL if any POSIX group
 * member ignores SIGTERM. Returns the signal that actually ended it, which the
 * timeout branch reports as `exit_signal`.
 */
export async function terminateChild(proc: ChildProcess): Promise<'SIGTERM' | 'SIGKILL'> {
  if (SUPPORTS_PROCESS_GROUPS) {
    if (!signalOwnedPosixProcessGroup(proc, 'SIGTERM')) {
      proc.kill('SIGTERM');
      await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
      return 'SIGTERM';
    }
    if (await waitForOwnedPosixTreeToQuiesce(proc, TREE_TERM_GRACE_MS)) {
      return 'SIGTERM';
    }
    if (!signalOwnedPosixProcessGroup(proc, 'SIGKILL')) proc.kill('SIGKILL');
    await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
    return 'SIGKILL';
  }

  return terminateWindowsProcessTree(proc);
}

/** Spawn the real CLI beneath a persistent process-group ownership anchor. */
export function spawnSupervisedCli(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
): SupervisedCli {
  const supervisor = spawn(
    process.execPath,
    ['-e', CLI_SUPERVISOR_SOURCE, '--', binary, ...args],
    {
      detached: SUPPORTS_PROCESS_GROUPS,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }
  );
  const targetExit = new Promise<TargetExit>((resolve) => {
    let settled = false;
    const settle = (target: TargetExit) => {
      if (settled) return;
      settled = true;
      resolve(target);
    };
    supervisor.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message == null) return;
      const value = message as Record<string, unknown>;
      if (value.type !== 'target-exit') return;
      settle({
        exitCode: typeof value.code === 'number' ? value.code : null,
        signalCode: typeof value.signal === 'string' ? (value.signal as NodeJS.Signals) : null,
        error: typeof value.error === 'string' ? value.error : null,
      });
    });
    supervisor.once('error', (error) => {
      settle({ exitCode: null, signalCode: null, error: error.message });
    });
    supervisor.once('exit', (code, signal) => {
      settle({
        exitCode: code,
        signalCode: signal,
        error: 'automation process supervisor exited before reporting the CLI outcome',
      });
    });
  });
  return { supervisor, targetExit };
}
