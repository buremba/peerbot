import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from '../daemon/executor.js';
import { runShellBuiltin } from '../daemon/builtins/os-shell.js';

function processIsLive(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3);
      return state !== 'Z';
    }
    process.kill(pid, 0);
    if (process.platform === 'darwin') {
      process.kill(pid, 0);
      return true;
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return false;
    throw error;
  }
}

function forceKill(pid: number, group = false): void {
  try {
    process.kill(group ? -pid : pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function stubClient() {
  const completions: Array<Record<string, unknown>> = [];
  return {
    client: {
      id: 'headless:test',
      async heartbeat() {},
      async completeAction(input: Record<string, unknown>) {
        completions.push(input);
      },
    },
    completions,
  };
}

describe('daemon-builtin os.shell', () => {
  test('uses a minimal child environment and does not inherit control-plane env', async () => {
    const sentinels = {
      WORKER_API_TOKEN: process.env.WORKER_API_TOKEN,
      LOBU_API_TOKEN: process.env.LOBU_API_TOKEN,
      LOBU_MEMORY_URL: process.env.LOBU_MEMORY_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      LOBU_ENCRYPTION_KEY: process.env.LOBU_ENCRYPTION_KEY,
      AUTH_SECRET: process.env.AUTH_SECRET,
      PROVIDER_API_KEY: process.env.PROVIDER_API_KEY,
    };
    Object.assign(process.env, {
      WORKER_API_TOKEN: 'worker-secret',
      LOBU_API_TOKEN: 'api-secret',
      LOBU_MEMORY_URL: 'https://memory.invalid',
      DATABASE_URL: 'postgres://secret',
      LOBU_ENCRYPTION_KEY: 'encryption-secret',
      AUTH_SECRET: 'auth-secret',
      PROVIDER_API_KEY: 'provider-secret',
    });
    try {
      const result = await runShellBuiltin({
        command: 'printf "PATH=%s\\nHOME=%s\\nTMPDIR=%s\\n" "$PATH" "$HOME" "$TMPDIR"; env',
        cwd: process.cwd(),
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toMatch(/PATH=.+/);
      expect(result.stdout).toMatch(/HOME=.+/);
      expect(result.stdout).toMatch(/TMPDIR=.+/);
      for (const name of Object.keys(sentinels)) expect(result.stdout).not.toContain(`${name}=`);
      expect(result.stdout).toContain('LC_ALL=C');
    } finally {
      for (const [name, value] of Object.entries(sentinels)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('force-kills SIGTERM-ignoring descendants in its process group', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lobu-shell-test-'));
    let descendantPid = 0;
    try {
      const output = await runShellBuiltin({
        command: `node -e 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); fs.writeFileSync("./ready", String(process.pid)); setTimeout(() => {}, 10000)' >/dev/null 2>&1 & while [ ! -s ./ready ]; do sleep 0.01; done; cat ./ready; wait`,
        cwd: testDir,
        timeout_ms: 300,
      });
      descendantPid = Number(output.stdout.trim());

      expect(output.timed_out).toBe(true);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(processIsLive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 0 && processIsLive(descendantPid)) forceKill(descendantPid);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('bounds settlement without claiming ownership of a detached session', async () => {
    if (process.platform !== 'linux') return;

    let escapedPid = 0;
    try {
      const started = Date.now();
      const output = await runShellBuiltin({
        command: `setsid bash -c 'trap "" TERM; sleep 10' & echo $!; wait`,
        cwd: process.cwd(),
        timeout_ms: 300,
      });
      escapedPid = Number(output.stdout.trim());

      expect(output.timed_out).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_500);
      expect(Number.isInteger(escapedPid)).toBe(true);
      // A deliberately new session is outside the supervisor's owned group;
      // the test owns this exact PID/group and cleans it up below.
      expect(processGroupExists(escapedPid)).toBe(true);
    } finally {
      if (escapedPid > 0) forceKill(escapedPid, true);
    }
  });

  test('does not reject when the command exits before consuming stdin', async () => {
    const output = await runShellBuiltin({
      command: 'exit 0',
      cwd: process.cwd(),
      stdin: 'x'.repeat(1_000_000),
    });

    expect(output.success).toBe(true);
    expect(output.exit_code).toBe(0);
  });

  test('executes without compiled connector code or connector SDK resolution', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(
      client as never,
      {
        run_id: 464,
        run_type: 'action',
        connector_key: 'os.shell',
        connector_version: '0.2.0',
        connector_manifest_hash: 'test-manifest-hash',
        execution_backend: 'daemon_builtin',
        action_key: 'run',
        action_input: {
          command: "printf 'lobu-shell-ok\\n'",
          cwd: process.cwd(),
        },
      },
      {},
      { heartbeatIntervalMs: 5_000 }
    );

    expect(result).toEqual({ itemsCollected: 0 });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      run_id: 464,
      worker_id: 'headless:test',
      status: 'success',
      action_output: {
        stdout: 'lobu-shell-ok\n',
        stderr: '',
        exit_code: 0,
        success: true,
        timed_out: false,
      },
    });
  });

  test('fails closed when the declared built-in is not registered', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(
      client as never,
      {
        run_id: 465,
        run_type: 'action',
        connector_key: 'missing.builtin',
        execution_backend: 'daemon_builtin',
        action_key: 'run',
        action_input: {},
      },
      {}
    );

    expect(result.error).toStartWith('operation_backend_unavailable:');
    expect(completions[0]).toMatchObject({ status: 'failed' });
  });

  test('rejects a contradictory compiled payload', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(
      client as never,
      {
        run_id: 466,
        run_type: 'action',
        connector_key: 'os.shell',
        execution_backend: 'daemon_builtin',
        compiled_code: 'must not execute',
        action_key: 'run',
        action_input: { command: 'exit 0' },
      },
      {}
    );

    expect(result.error).toContain('must not contain compiled_code');
    expect(completions[0]).toMatchObject({ status: 'failed' });
  });

  test('bounds timeout while killing descendants in the owned process group', async () => {
    const { client, completions } = stubClient();
    const started = Date.now();
    const result = await executeRun(
      client as never,
      {
        run_id: 467,
        run_type: 'action',
        connector_key: 'os.shell',
        connector_version: '0.2.0',
        connector_manifest_hash: 'test-manifest-hash',
        execution_backend: 'daemon_builtin',
        action_key: 'run',
        action_input: {
          command: 'sleep 10 & wait',
          cwd: process.cwd(),
          timeout_ms: 300,
        },
      },
      {},
      { heartbeatIntervalMs: 5_000 }
    );

    expect(result.itemsCollected).toBe(0);
    expect(result.error).toStartWith('operation_execution_failed:');
    expect(Date.now() - started).toBeLessThan(5_500);
    expect(completions[0]?.status).toBe('failed');
    expect(completions[0]?.error_message).toStartWith('operation_execution_failed: Shell command timed out after ');
    expect(completions[0]?.action_output).toMatchObject({
      stdout: '', stderr: '', timed_out: true, success: false,
    });
  });

  test('preserves structured output for nonzero builtin results', async () => {
    const { client, completions } = stubClient();
    const result = await executeRun(client as never, {
      run_id: 468,
      run_type: 'action',
      connector_key: 'os.shell',
      connector_version: '0.2.0',
      execution_backend: 'daemon_builtin',
      action_key: 'run',
      action_input: { command: "printf out; printf err >&2; exit 7", cwd: process.cwd() },
    }, {}, { heartbeatIntervalMs: 5_000 });
    expect(result.error).toContain('operation_execution_failed: Shell command exited with code 7');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      status: 'failed',
      action_output: { stdout: 'out', stderr: 'err', exit_code: 7, timed_out: false, success: false },
    });
  });

  test('retries one immutable success payload after terminal delivery loss', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const client = {
      id: 'headless:test',
      async heartbeat() {},
      async completeAction(input: Record<string, unknown>) {
        payloads.push(structuredClone(input));
        attempts += 1;
        if (attempts === 1) throw new Error('response lost');
      },
    };
    await expect(executeRun(client as never, {
      run_id: 469,
      run_type: 'action',
      connector_key: 'os.shell',
      connector_version: '0.2.0',
      execution_backend: 'daemon_builtin',
      action_key: 'run',
      action_input: { command: 'printf success', cwd: process.cwd() },
    }, {}, { heartbeatIntervalMs: 5_000 })).resolves.toEqual({ itemsCollected: 0 });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[0]).toMatchObject({ status: 'success', action_output: { stdout: 'success' } });
  });

  test('retries one immutable failed payload after terminal delivery loss', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const client = {
      id: 'headless:test',
      async heartbeat() {},
      async completeAction(input: Record<string, unknown>) {
        payloads.push(structuredClone(input));
        attempts += 1;
        if (attempts === 1) throw new Error('response lost');
      },
    };
    await expect(executeRun(client as never, {
      run_id: 470,
      run_type: 'action',
      connector_key: 'os.shell',
      connector_version: '0.2.0',
      execution_backend: 'daemon_builtin',
      action_key: 'run',
      action_input: { command: 'printf err >&2; exit 7', cwd: process.cwd() },
    }, {}, { heartbeatIntervalMs: 5_000 })).resolves.toMatchObject({ itemsCollected: 0, error: expect.stringContaining('exited with code 7') });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[0]).toMatchObject({ status: 'failed', action_output: { stderr: 'err', exit_code: 7 } });
  });

  test('ignores poisoned Bash function state while enforcing timeout reaping', async () => {
    const previousBashFunction = process.env['BASH_FUNC_sleep%%'];
    const previousBashEnv = process.env.BASH_ENV;
    process.env['BASH_FUNC_sleep%%'] = '() { :; }';
    process.env.BASH_ENV = '/tmp/does-not-exist-lobu-shell-test';
    try {
      const started = Date.now();
      const result = await runShellBuiltin({
        command: 'trap "" TERM; sleep 30 & descendant=$!; echo "$descendant"; wait',
        cwd: process.cwd(),
        timeout_ms: 100,
      });
      expect(result.success).toBe(false);
      expect(result.timed_out).toBe(true);
      if (process.platform !== 'darwin') expect(processIsLive(Number(result.stdout.trim()))).toBe(false);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      if (previousBashFunction === undefined) delete process.env['BASH_FUNC_sleep%%'];
      else process.env['BASH_FUNC_sleep%%'] = previousBashFunction;
      if (previousBashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previousBashEnv;
    }
  });

  test('daemon abort kills a long-lived child and grandchild process tree', async () => {
    const shutdown = new AbortController();
    const started = Date.now();
    const pending = runShellBuiltin({
      command: 'sleep 30 & child=$!; sleep 30 & grandchild=$!; wait "$child" "$grandchild"',
      cwd: process.cwd(),
      timeout_ms: 300_000,
    }, shutdown.signal);
    setTimeout(() => shutdown.abort(), 100);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.timed_out).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
