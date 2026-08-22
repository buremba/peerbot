import { describe, expect, test } from 'bun:test';
import { executeNativeBridgeRun } from '../daemon/native-bridge/executor';

const item = (id: string) => ({
  id,
  payload_text: id,
  occurred_at: '2026-08-22T00:00:00Z',
});

function fakeClient() {
  const calls: Record<string, unknown[]> = { stream: [], complete: [], completeAction: [], completeAuth: [] };
  return {
    id: 'mac:test',
    calls,
    stream: async (value: unknown) => calls.stream.push(value),
    complete: async (value: unknown) => calls.complete.push(value),
    completeAction: async (value: unknown) => calls.completeAction.push(value),
    completeAuth: async (value: unknown) => calls.completeAuth.push(value),
  } as never;
}

describe('native bridge run forwarding', () => {
  test('forwards sync chunks in order and completes once with the final checkpoint', async () => {
    const client = fakeClient() as {
      calls: Record<string, unknown[]>;
      id: string;
      stream: (value: unknown) => Promise<void>;
    };
    const bridge = {
      run: async (options: { onStream?: (payload: Record<string, unknown>, sequence: number) => Promise<void> }) => {
        await options.onStream?.({ items: [item('a')] }, 1);
        await options.onStream?.({ items: [item('b')], checkpoint: { cursor: '2' } }, 2);
        return { checkpoint: { cursor: '2' } };
      },
    } as never;

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 9,
      run_type: 'sync',
      connector_key: 'apple.files',
      connector_version: '1.0.0',
      config: {},
    } as never);

    expect(result).toEqual({ itemsCollected: 2 });
    expect(client.calls.stream).toHaveLength(2);
    expect((client.calls.stream[0] as { items: { id: string }[] }).items.map((entry) => entry.id)).toEqual(['a']);
    expect((client.calls.stream[1] as { items: { id: string }[] }).items.map((entry) => entry.id)).toEqual(['b']);
    expect(client.calls.complete).toEqual([
      expect.objectContaining({ run_id: 9, status: 'success', items_collected: 2, checkpoint: { cursor: '2' } }),
    ]);
  });

  test('completes an action exactly once and never retries after bridge failure', async () => {
    const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
    let runCalls = 0;
    const bridge = {
      run: async () => {
        runCalls++;
        throw new Error('app EOF');
      },
    } as never;

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 10,
      run_type: 'action',
      action_key: 'open',
      action_input: {},
    } as never);

    expect(result.error).toBe('app EOF');
    expect(runCalls).toBe(1);
    expect(client.calls.completeAction).toEqual([
      expect.objectContaining({ run_id: 10, status: 'failed', error_message: 'app EOF' }),
    ]);
  });

  test('does not advance or commit a checkpoint from a failed stream', async () => {
    const client = fakeClient() as {
      calls: Record<string, unknown[]>;
      id: string;
      stream: (value: unknown) => Promise<void>;
    };
    const bridge = {
      run: async (options: { onStream?: (payload: Record<string, unknown>, sequence: number) => Promise<void> }) => {
        await options.onStream?.({ items: [item('a')], checkpoint: { cursor: '1' } }, 1);
        await options.onStream?.({ items: [item('b')], checkpoint: { cursor: '2' } }, 2);
        return { checkpoint: { cursor: '2' } };
      },
    } as never;
    let streamCalls = 0;
    client.stream = async (value: unknown) => {
      streamCalls += 1;
      if (streamCalls === 2) throw new Error('stream delivery failed');
      client.calls.stream.push(value);
    };

    const result = await executeNativeBridgeRun(client as never, bridge, {
      run_id: 11,
      run_type: 'sync',
      connector_key: 'apple.files',
    } as never);

    expect(result.error).toBe('stream delivery failed');
    expect(client.calls.complete).toEqual([
      expect.objectContaining({ run_id: 11, status: 'failed', items_collected: 1 }),
    ]);
    expect((client.calls.complete[0] as Record<string, unknown>).checkpoint).toBeUndefined();
  });

  test('completes auth exactly once with bridge credentials and metadata', async () => {
    const client = fakeClient() as { calls: Record<string, unknown[]>; id: string };
    const bridge = {
      run: async () => ({
        credentials: { access_token: 'scoped-result' },
        metadata: { profile: 'device' },
      }),
    } as never;

    await expect(
      executeNativeBridgeRun(client as never, bridge, {
        run_id: 12,
        run_type: 'auth',
        connector_key: 'apple.files',
      } as never),
    ).resolves.toEqual({ itemsCollected: 0 });
    expect(client.calls.completeAuth).toEqual([
      expect.objectContaining({
        run_id: 12,
        status: 'success',
        credentials: { access_token: 'scoped-result' },
        metadata: { profile: 'device' },
      }),
    ]);
  });
});
