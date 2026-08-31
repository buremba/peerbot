import { describe, expect, test } from 'bun:test';
import { executeRun } from '../daemon/executor.js';
import { runShellBuiltin } from '../daemon/builtins/os-shell.js';

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
  test('uses a minimal child environment and does not leak worker or control-plane secrets', async () => {
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
          command: 'sleep 5 & wait',
          cwd: process.cwd(),
          timeout_ms: 300,
        },
      },
      {},
      { heartbeatIntervalMs: 5_000 }
    );

    expect(result.itemsCollected).toBe(0);
    expect(result.error).toStartWith('operation_execution_failed:');
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(completions[0]?.status).toBe('failed');
    expect(completions[0]?.error_message).toStartWith('operation_execution_failed: Shell command timed out after ');
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
