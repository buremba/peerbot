import { createLogger } from "@lobu/core";

const logger = createLogger("watcher-run-tracker");

export type WatcherRunResult = { ok: true } | { ok: false; error: string };

export interface WatcherRunHandle {
  messageId: string;
  runId: number;
  watcherId: number;
  organizationId: string;
  onResolve: (result: WatcherRunResult) => Promise<void>;
}

/**
 * In-process registry of watcher runs awaiting completion.
 *
 * Dispatch registers a handle keyed by the agent messageId; the API response
 * renderer calls resolve() when the agent turn finishes (success or error).
 * Resolve is idempotent — duplicate events are dropped.
 *
 * This is the fast path. Durable correlation lives in runs.dispatched_message_id
 * and watcher_windows.run_id so a gateway restart can reconcile without it.
 */
export class WatcherRunTracker {
  private readonly pending = new Map<string, WatcherRunHandle>();

  register(handle: WatcherRunHandle): void {
    if (this.pending.has(handle.messageId)) {
      logger.warn(
        { messageId: handle.messageId, runId: handle.runId },
        "duplicate watcher run registration ignored"
      );
      return;
    }
    this.pending.set(handle.messageId, handle);
  }

  async resolve(messageId: string, result: WatcherRunResult): Promise<void> {
    const handle = this.pending.get(messageId);
    if (!handle) return;
    this.pending.delete(messageId);
    try {
      await handle.onResolve(result);
    } catch (err) {
      logger.error(
        { err, messageId, runId: handle.runId },
        "watcher run onResolve callback failed"
      );
    }
  }

  unregister(messageId: string): void {
    this.pending.delete(messageId);
  }

  size(): number {
    return this.pending.size;
  }
}
