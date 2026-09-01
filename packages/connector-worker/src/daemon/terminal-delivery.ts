/**
 * One terminal-completion policy for the whole daemon.
 *
 * Both the ordinary executor path and the failure-reporting path awaited
 * `client.completeAction` directly, which neither retries nor bounds its wait:
 * a single dropped connection lost an already-decided outcome and left the run
 * to the gateway's stale-run reaper. Route both through one bounded retry so
 * the outcome survives a transient failure without either caller inventing its
 * own budget. A `WorkerDecodeError` is rethrown rather than retried -- a retry
 * cannot fix a payload the gateway could not parse, and re-sending would hide
 * the protocol fault behind a timeout.
 */
import { WorkerDecodeError } from './client.js';
import type { ExecutorClient } from './client.js';

const TERMINAL_DELIVERY_DEADLINE_MS = 15_000;
const TERMINAL_DELIVERY_ATTEMPTS = 2;

async function withTerminalDeliveryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('terminal completion deadline exceeded')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Retry one immutable terminal payload without changing its outcome.
 *
 * A timed-out attempt is retried, not abandoned: a hung connection is the
 * commonest transient failure, and abandoning it there would leave the rest of
 * the deadline unused. The timeout does not cancel the in-flight request, so a
 * retry can reach a gateway that already accepted the first one -- that is
 * safe because the gateway's terminal write is fenced
 * (`status = 'running' AND claimed_by = worker_id`) and answers a second
 * delivery with `already_finalized` rather than re-finalizing the run.
 */
export async function completeActionOnce(
  client: ExecutorClient,
  payload: Parameters<ExecutorClient['completeAction']>[0]
): Promise<void> {
  const deadline = Date.now() + TERMINAL_DELIVERY_DEADLINE_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < TERMINAL_DELIVERY_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      // Split the remaining budget across the attempts still to come, so a hung
      // connection cannot spend the whole deadline before anything is retried.
      const attemptsLeft = TERMINAL_DELIVERY_ATTEMPTS - attempt;
      await withTerminalDeliveryTimeout(
        client.completeAction(payload),
        Math.max(1, Math.floor(remaining / attemptsLeft))
      );
      return;
    } catch (error) {
      if (error instanceof WorkerDecodeError) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
