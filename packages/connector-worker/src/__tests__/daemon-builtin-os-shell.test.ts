import { describe, expect, test } from 'bun:test';
import { executeRun } from '../daemon/executor.js';

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
});
