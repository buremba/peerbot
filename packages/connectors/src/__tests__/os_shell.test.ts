/**
 * os.shell connector - runs commands and returns structured output.
 */

import { describe, expect, it } from 'bun:test';
import OsShellConnector from '../os_shell.js';

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
    const result = await connector.execute(
      runContext('run', { command: 'sleep 10', timeout_ms: 300 })
    );
    expect(result.success).toBe(false);
    const output = result.output as Record<string, unknown>;
    expect(output.timed_out).toBe(true);
  });

  it('rejects an unknown action', async () => {
    const result = await connector.execute(runContext('nope', {}));
    expect(result.success).toBe(false);
  });
});