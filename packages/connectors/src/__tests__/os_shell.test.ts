/**
 * os.shell connector - runs commands and returns structured output.
 */

import { describe, expect, it, mock } from 'bun:test';
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

describe('os.shell connector', () => {
  const connector = new OsShellConnector();

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

  it('force-kills redirected descendants after the shell leader closes', async () => {
    const result = await connector.execute(
      runContext('run', {
        // Print the descendant pid, then wait on a child that ignores SIGTERM
        // and owns no shell pipes. The grace timer must still SIGKILL it.
        command: `bash -c 'trap "" TERM; sleep 10' >/dev/null 2>&1 & echo $!; wait`,
        timeout_ms: 300,
      })
    );
    const output = result.output as Record<string, unknown>;
    const descendantPid = Number(String(output.stdout).trim());
    expect(output.timed_out).toBe(true);
    expect(Number.isInteger(descendantPid)).toBe(true);

    // Some minimal PID 1 implementations reap orphans only when the test
    // process exits. A zombie is already dead; only a live state means the
    // descendant escaped the process-tree timeout.
    let live = false;
    try {
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3);
        live = state !== 'Z';
      } else {
        process.kill(descendantPid, 0);
        live = true;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') throw err;
    }
    expect(live).toBe(false);
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
