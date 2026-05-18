/**
 * `bindRequestAbortToStream` — bridge a Hono per-request `AbortSignal` to a
 * Hono `StreamingApi` so abnormal disconnects (LB idle timeout, proxy kill,
 * client hard close) actually tear the stream down.
 *
 * Hono's `streamSSE` / `stream` helpers only invoke `streamWriter.onAbort`
 * subscribers when the underlying `ReadableStream.cancel()` runs. On
 * Node + current Bun, `cancel()` doesn't fire for abnormal disconnects —
 * which leaves any heartbeat `setInterval`, registered listener, or
 * `while !aborted` loop running forever. Issue lobu-ai/lobu#782.
 *
 * The invalidation-event streams already use a raw `ReadableStream` with the
 * same bridge wired inline (`events/sse.ts`, fixed in PR #833). The two
 * remaining Hono-streaming routes — the agent SSE channel at
 * `/api/v1/agents/:agentId/events` and the worker SSE channel at
 * `/worker/stream` — need the same bridge. This helper centralizes it so
 * the pattern doesn't drift again the next time we add an SSE route.
 *
 * Caller contract:
 *   const detach = bindRequestAbortToStream(c.req.raw.signal, stream);
 *   try { ... } finally { detach(); }
 *
 * `detach()` is idempotent. The function returns immediately (and `detach`
 * is a no-op) if the signal is already aborted — the caller is expected to
 * check `signal.aborted` and bail before doing real work.
 */

/** Minimal shape we need off Hono's `StreamingApi` / `SSEStreamingApi`. */
export interface AbortableStream {
  readonly aborted: boolean;
  readonly closed: boolean;
  abort(): void;
}

export function bindRequestAbortToStream(
  signal: AbortSignal | undefined,
  stream: AbortableStream
): () => void {
  if (!signal) return () => {};

  const onAbort = () => {
    if (!stream.aborted && !stream.closed) {
      stream.abort();
    }
  };

  // If already aborted, fire synchronously so the caller's loop sees it on
  // the next check. addEventListener with `once: true` would also fire if
  // re-dispatched, but the platform doesn't re-dispatch already-aborted
  // signals — so we have to do it ourselves.
  if (signal.aborted) {
    onAbort();
    return () => {};
  }

  signal.addEventListener('abort', onAbort, { once: true });

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    signal.removeEventListener('abort', onAbort);
  };
}
