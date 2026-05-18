/**
 * Regression test for lobu-ai/lobu#782: the abort-bridge helper used by the
 * Hono-streaming SSE routes (agent SSE channel + worker SSE channel) must
 * tear the stream down when the per-request `AbortSignal` fires, even when
 * `ReadableStream.cancel()` never runs.
 *
 * The helper is a thin pure-JS bridge — these tests exercise it directly
 * against a stub `AbortableStream`, mirroring the contract documented in
 * `events/sse-abort-bridge.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  bindRequestAbortToStream,
  type AbortableStream,
} from '../../events/sse-abort-bridge';

function fakeStream(): AbortableStream & { abortCalls: number } {
  return {
    aborted: false,
    closed: false,
    abortCalls: 0,
    abort() {
      this.abortCalls++;
      (this as { aborted: boolean }).aborted = true;
    },
  };
}

describe('bindRequestAbortToStream', () => {
  it('calls stream.abort() when the request signal aborts', () => {
    const ctrl = new AbortController();
    const stream = fakeStream();

    const detach = bindRequestAbortToStream(ctrl.signal, stream);
    expect(stream.abortCalls).toBe(0);

    ctrl.abort();
    expect(stream.abortCalls).toBe(1);

    // detach is safe to call after abort has fired.
    detach();
  });

  it('fires synchronously if the signal is already aborted at bind time', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = fakeStream();

    bindRequestAbortToStream(ctrl.signal, stream);

    expect(stream.abortCalls).toBe(1);
  });

  it('detach() prevents the listener from firing later', () => {
    const ctrl = new AbortController();
    const stream = fakeStream();

    const detach = bindRequestAbortToStream(ctrl.signal, stream);
    detach();

    ctrl.abort();
    expect(stream.abortCalls).toBe(0);
  });

  it('detach() is idempotent', () => {
    const ctrl = new AbortController();
    const stream = fakeStream();

    const detach = bindRequestAbortToStream(ctrl.signal, stream);
    detach();
    detach(); // must not throw
    expect(stream.abortCalls).toBe(0);
  });

  it('does not call abort() if the stream already closed', () => {
    const ctrl = new AbortController();
    const stream = fakeStream();
    (stream as { closed: boolean }).closed = true;

    bindRequestAbortToStream(ctrl.signal, stream);
    ctrl.abort();

    expect(stream.abortCalls).toBe(0);
  });

  it('does not call abort() if the stream already aborted', () => {
    const ctrl = new AbortController();
    const stream = fakeStream();
    (stream as { aborted: boolean }).aborted = true;

    bindRequestAbortToStream(ctrl.signal, stream);
    ctrl.abort();

    expect(stream.abortCalls).toBe(0);
  });

  it('returns a no-op detach when no signal is provided', () => {
    const stream = fakeStream();
    const detach = bindRequestAbortToStream(undefined, stream);
    detach(); // must not throw
    expect(stream.abortCalls).toBe(0);
  });
});

describe('bindRequestAbortToStream + Hono streamSSE (integration)', () => {
  /**
   * Reproduces the #782 leak shape end-to-end:
   *   1. Mount a Hono route that uses `streamSSE` + a per-iteration heartbeat
   *      interval + a `while !aborted` loop.
   *   2. Wire the abort bridge.
   *   3. Hit the route and abort the request without consuming the body or
   *      cancelling the response stream.
   *   4. Assert the heartbeat interval has been cleared and the loop has
   *      exited within a short bounded wait.
   *
   * Before the fix, the loop runs forever and the interval keeps firing —
   * the test would time out the post-abort assertion.
   */
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  it('tears down heartbeat + loop on request abort', async () => {
    const { Hono } = await import('hono');
    const { streamSSE } = await import('hono/streaming');

    const activeTimers = new Set<unknown>();
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const handle = originalSetInterval(fn, ms);
      activeTimers.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: unknown) => {
      activeTimers.delete(handle);
      return originalClearInterval(
        handle as Parameters<typeof clearInterval>[0]
      );
    }) as typeof clearInterval;

    try {
      let loopExited = false;
      const app = new Hono();
      app.get('/sse', (c) =>
        streamSSE(c, async (stream) => {
          if (c.req.raw.signal?.aborted) return;

          const heartbeat = setInterval(() => {
            stream.writeSSE({ event: 'ping', data: 'x' }).catch(() => {});
          }, 50);

          const detach = bindRequestAbortToStream(c.req.raw.signal, stream);
          try {
            await stream.writeSSE({ event: 'connected', data: '{}' });
            while (!stream.aborted && !stream.closed) {
              await stream.sleep(25);
            }
          } finally {
            clearInterval(heartbeat);
            detach();
            loopExited = true;
          }
        })
      );

      const ctrl = new AbortController();
      const req = new Request('http://localhost/sse', {
        method: 'GET',
        signal: ctrl.signal,
      });

      // Fire the request without awaiting the body — we want to abort while
      // the handler is mid-loop.
      const respPromise = app.fetch(req);
      // Give the handler time to register interval + write connected event.
      await new Promise((r) => setTimeout(r, 75));

      expect(activeTimers.size).toBeGreaterThanOrEqual(1);

      ctrl.abort();

      // Wait for the loop to exit (max 500ms — sleep granularity is 25ms).
      const deadline = Date.now() + 500;
      while (!loopExited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(loopExited).toBe(true);
      expect(activeTimers.size).toBe(0);

      // Drain the response so we don't leak the body.
      try {
        const resp = await Promise.resolve(respPromise);
        await resp.body?.cancel();
      } catch {
        /* ignore */
      }
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      for (const handle of activeTimers) {
        originalClearInterval(handle as Parameters<typeof clearInterval>[0]);
      }
    }
  });
});
