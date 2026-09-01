/**
 * os.shell connector - runs commands and returns structured output.
 */

import { describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

const { default: OsShellConnector } = await import('../os_shell.js');

function runContext(actionKey: string, input: Record<string, unknown>) {
  return {
    actionKey,
    input,
    credentials: null,
    config: {},
  } as never;
}

function processIsLive(pid: number): boolean {
  // pid 0 targets the caller's OWN process group and pid 1 is init; neither is
  // a descendant, and process.kill reports both as live. An empty stdout parses
  // to 0, so reject it here rather than reporting a phantom escaped process.
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`processIsLive: ${pid} is not a descendant pid`);
  }
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3);
      return state !== 'Z';
    }
    process.kill(pid, 0);
    if (process.platform === 'darwin') {
      // A zombie still answers kill(pid, 0), so ask `ps` for the real state.
      // Between that signal probe and this call the pid can be reaped, and
      // `ps` then exits 1 with no stdout -- which execFileSync raises as an
      // error carrying a `status`, not an ESRCH/ENOENT `code`, so the handler
      // below would rethrow it and fail the test. A pid `ps` cannot find is
      // not an error here: it is the definition of not live.
      let state: string;
      try {
        state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return false;
      }
      return state !== '' && !state.startsWith('Z');
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return false;
    throw err;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsLive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsLive(pid);
}

function forceKillProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

describe('os.shell connector', () => {
  const connector = new OsShellConnector();

  it('rejects timeout values beyond the published execution budget', async () => {
    const result = await connector.execute(
      runContext('run', { command: 'printf nope', timeout_ms: 150001 })
    );
    expect(result).toEqual({
      success: false,
      error: 'timeout_ms must be an integer between 100 and 150000',
    });
  });
  it('runs a command and returns stdout with exit 0', async () => {
    const result = await connector.execute(
      runContext('run', { command: 'echo hello-from-shell' })
    );
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.stdout).toContain('hello-from-shell');
    expect(output.exit_code).toBe(0);
    expect(output.timed_out).toBe(false);
    expect(typeof output.duration_ms).toBe('number');
  });

  it('returns stderr and non-zero exit for a failing command', async () => {
    const result = await connector.execute(
      runContext('run', { command: 'echo oops >&2; exit 3' })
    );
    expect(result.success).toBe(false);
    const output = result.output as Record<string, unknown>;
    expect(output.exit_code).toBe(3);
    expect(output.stderr).toContain('oops');
  });

  it('respects timeout_ms and reports timed_out', async () => {
    const started = Date.now();
    const result = await connector.execute(
      runContext('run', {
        // The background child keeps the shell's output pipes open. Killing
        // only bash would make this call take the full five seconds.
        command: 'sleep 5 & wait',
        timeout_ms: 300,
      })
    );
    expect(result.success).toBe(false);
    const output = result.output as Record<string, unknown>;
    expect(output.timed_out).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('does not crash when a command exits without consuming stdin', async () => {
    const result = await connector.execute(
      runContext('run', {
        command: 'exit 0',
        stdin: 'x'.repeat(1000000),
      })
    );
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.exit_code).toBe(0);
  });

  it('passes stdin through the process-group anchor', async () => {
    const result = await connector.execute(
      runContext('run', { command: 'cat', stdin: 'stdin-through-anchor' })
    );
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).stdout).toBe('stdin-through-anchor');
  });

  it('force-kills SIGTERM-ignoring descendants in the owned process group', async () => {
    const result = await connector.execute(
      runContext('run', {
        // Print the descendant pid, then wait on a child that ignores SIGTERM
        // and owns no shell pipes. The grace timer must still SIGKILL it.
        command: `bash -c 'trap "" TERM; sleep 10' >/dev/null 2>&1 & echo $!; wait`,
        // Longer than the other timeout cases: this one must actually reach the
        // echo and print a pid, and `bash -lc` profile sourcing alone can
        // exceed 300ms on darwin. There is no elapsed-time assertion here.
        timeout_ms: 1500,
      })
    );
    const output = result.output as Record<string, unknown>;
    const descendantPid = Number(String(output.stdout).trim());
    expect(output.timed_out).toBe(true);
    expect(descendantPid).toBeGreaterThan(1);

    // Some minimal PID 1 implementations reap orphans only when the test
    // process exits. A zombie is already dead; only a live state means the
    // same-group descendant escaped cleanup. SIGKILL delivery and reaping are
    // both asynchronous, so poll rather than sampling once and racing the
    // kernel on a loaded machine.
    expect(await waitForProcessExit(descendantPid, 2000)).toBe(true);
  });

  it('settles on time when a session-detached child inherits stdio', async () => {
    if (process.platform !== 'linux') return;

    let escapedPid = 0;
    try {
      const started = Date.now();
      const result = await connector.execute(
        runContext('run', {
          command: `setsid bash -c 'trap "" TERM; sleep 10' & echo $!; wait`,
          timeout_ms: 300,
        })
      );
      const output = result.output as Record<string, unknown>;
      escapedPid = Number(String(output.stdout).trim());

      expect(output.timed_out).toBe(true);
      expect(Date.now() - started).toBeLessThan(5500);
      expect(escapedPid).toBeGreaterThan(1);
      // setsid is explicitly outside process-group cleanup. The connector must
      // return on time even though the escaped session is still alive.
      expect(processGroupExists(escapedPid)).toBe(true);
    } finally {
      if (escapedPid > 0) forceKillProcessGroup(escapedPid);
    }
  });

  it('settles on time when a redirected child escapes into a new session', async () => {
    if (process.platform !== 'linux') return;

    let escapedPid = 0;
    try {
      const started = Date.now();
      const result = await connector.execute(
        runContext('run', {
          command: `setsid bash -c 'trap "" TERM; sleep 10' >/dev/null 2>&1 & echo $!; wait`,
          timeout_ms: 300,
        })
      );
      const output = result.output as Record<string, unknown>;
      escapedPid = Number(String(output.stdout).trim());

      expect(output.timed_out).toBe(true);
      expect(Date.now() - started).toBeLessThan(5500);
      expect(escapedPid).toBeGreaterThan(1);
      expect(processGroupExists(escapedPid)).toBe(true);
    } finally {
      if (escapedPid > 0) forceKillProcessGroup(escapedPid);
    }
  });

  it('rejects an unknown action', async () => {
    const result = await connector.execute(runContext('nope', {}));
    expect(result.success).toBe(false);
  });

  it('truncates oversized output instead of buffering it all', async () => {
    const result = await connector.execute(
      runContext('run', { command: 'yes x | head -c 4000000' }),
    );
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(String(output.stdout).length).toBeLessThan(2000000);
    expect(String(output.stdout)).toContain('(output truncated)');
  });

  it('rejects a relative or non-existent cwd', async () => {
    const rel = await connector.execute(
      runContext('run', { command: 'pwd', cwd: 'relative/path' }),
    );
    expect(rel.success).toBe(false);
    const missing = await connector.execute(
      runContext('run', { command: 'pwd', cwd: '/definitely/not/a/real/dir' }),
    );
    expect(missing.success).toBe(false);
  });

  it('defaults cwd to the device home', async () => {
    const result = await connector.execute(runContext('run', { command: 'pwd' }));
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(String(output.stdout).trim()).toBe(require('node:os').homedir());
  });
});
