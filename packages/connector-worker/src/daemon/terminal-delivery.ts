/**
 * One terminal-completion policy for the whole daemon.
 *
 * Both the ordinary executor path and the failure-reporting path must deliver
 * an already-decided outcome under the same bounded budget. They used to carry
 * separate copies with separate constants, and the copies had already drifted:
 * one rethrew a decode error immediately, the other retried it. A retry cannot
 * fix a payload the gateway could not parse, and re-sending hides the protocol
 * fault behind a timeout.
 */
import { WorkerDecodeError } from './client.js';
import type { ExecutorClient } from './client.js';

export const TERMINAL_DELIVERY_DEADLINE_MS = 15_000;

export async function withTerminalDeliveryTimeout<T>(
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

/** Retry one immutable terminal payload without changing its outcome. */
export async function completeActionOnce(
  client: ExecutorClient,
  payload: Parameters<ExecutorClient['completeAction']>[0]
): Promise<void> {
  const deadline = Date.now() + TERMINAL_DELIVERY_DEADLINE_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const attemptsLeft = 2 - attempt;
      await withTerminalDeliveryTimeout(
        client.completeAction(payload),
        Math.max(1, Math.floor(remaining / attemptsLeft))
      );
      return;
    } catch (error) {
      if (error instanceof WorkerDecodeError) throw error;
      lastError = error;
      if (error instanceof Error && error.message === 'terminal completion deadline exceeded') break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
