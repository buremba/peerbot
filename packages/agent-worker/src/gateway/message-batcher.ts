/**
 * Message batching for grouping rapid messages
 */

import { createLogger, type QueuedMessage } from "@lobu/core";

const logger = createLogger("message-batcher");

interface BatcherConfig {
  onBatchReady?: (messages: QueuedMessage[]) => Promise<void>;
  batchWindowMs?: number;
}

/**
 * Simple message batcher - collects messages for a short window, then processes
 */
export class MessageBatcher {
  private messageQueue: QueuedMessage[] = [];
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageOrder: string[] = [];
  private isProcessing = false;
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly batchWindowMs: number;
  private readonly onBatchReady?: (messages: QueuedMessage[]) => Promise<void>;
  private hasProcessedInitialBatch = false;
  private stopped = false;

  constructor(config: BatcherConfig = {}) {
    this.batchWindowMs = config.batchWindowMs ?? 2000; // 2 second window by default
    this.onBatchReady = config.onBatchReady;
  }

  async addMessage(message: QueuedMessage): Promise<void> {
    if (!this.claimMessageId(message.payload.messageId)) return;
    await this.addClaimedMessage(message);
  }

  /**
   * Atomically reserve a delivery before any await or live-steering side
   * effect. The SSE client uses this before steering so a redelivery cannot be
   * injected into an active model turn twice.
   */
  claimMessageId(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) {
      logger.info(`Ignoring duplicate message ${messageId}`);
      return false;
    }
    this.seenMessageIds.add(messageId);
    this.seenMessageOrder.push(messageId);
    if (this.seenMessageOrder.length > 10_000) {
      const oldest = this.seenMessageOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    return true;
  }

  /**
   * Queue a control message (e.g. `!`-bash) whose ID was already reserved, and
   * flush it as its own batch WITHOUT waiting out the batch window — but only
   * when no turn is in flight. This preserves the batcher's serialization
   * guarantee (never two concurrent `onBatchReady` runs): when a turn is already
   * processing, the message is merely queued and picked up by the next batch,
   * exactly like {@link addClaimedMessage}. It differs only in that, when idle,
   * it processes immediately instead of opening a 2000ms window. The caller is
   * responsible for keeping such a message batch-isolated (never merged into a
   * combined "Message N:" prompt) inside `onBatchReady`.
   */
  async addPriorityMessage(message: QueuedMessage): Promise<void> {
    this.messageQueue.push(message);

    if (this.stopped) return;

    // A turn is in flight: queue only. processBatch()'s tail picks it up when
    // the active turn finishes, so we never start a second concurrent turn.
    if (this.isProcessing) {
      logger.info(
        `Priority message queued (${this.messageQueue.length} pending, processing in progress)`
      );
      return;
    }

    // Idle: flush now, skipping the batch window. Clear any pending timer first
    // so a window that was about to fire doesn't double-process the queue.
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.hasProcessedInitialBatch = true;
    await this.processBatch();
  }

  /** Queue a message whose ID was already reserved by claimMessageId(). */
  async addClaimedMessage(message: QueuedMessage): Promise<void> {
    this.messageQueue.push(message);

    if (this.stopped) return;

    // If already processing, message will be picked up in next batch
    if (this.isProcessing) {
      logger.info(
        `Message queued (${this.messageQueue.length} pending, processing in progress)`
      );
      return;
    }

    // If no batch timer running, start one
    if (!this.batchTimer) {
      if (!this.hasProcessedInitialBatch) {
        this.hasProcessedInitialBatch = true;
        logger.info(
          `Processing first message immediately (skipping ${this.batchWindowMs}ms batch window)`
        );
        await this.processBatch();
        return;
      }

      logger.info(
        `Starting ${this.batchWindowMs}ms batch window (${this.messageQueue.length} message(s))`
      );
      this.batchTimer = setTimeout(() => {
        void this.processBatch().catch(() => {
          // Error already logged in processBatch
        });
      }, this.batchWindowMs);
    } else {
      logger.info(
        `Message added to batch window (${this.messageQueue.length} pending)`
      );
    }
  }

  /**
   * Restore the never-attempted suffix of a batch whose callback failed.
   * These IDs were reserved before the original batch was captured, so this
   * deliberately bypasses claimMessageId(). Prepend them ahead of messages
   * that arrived while the failed callback was running to preserve delivery
   * order without replaying the already-attempted prefix.
   */
  requeueClaimedMessages(messages: QueuedMessage[]): void {
    if (messages.length === 0) return;
    this.messageQueue = [...messages, ...this.messageQueue];

    if (this.stopped) return;

    // Production calls this from onBatchReady while isProcessing is true, and
    // processBatch() schedules the restored suffix in its finally block. Keep
    // the method safe for direct callers too.
    if (!this.isProcessing && !this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        void this.processBatch().catch((error) => {
          logger.error("Error during requeued batch processing:", error);
        });
      }, this.batchWindowMs);
    }
  }

  private async processBatch(): Promise<void> {
    if (this.stopped) return;

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.messageQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const messagesToProcess = [...this.messageQueue];
      this.messageQueue = [];

      logger.info(`Processing batch of ${messagesToProcess.length} messages`);
      messagesToProcess.sort((a, b) => a.timestamp - b.timestamp);

      if (this.onBatchReady) {
        await this.onBatchReady(messagesToProcess);
      }
    } finally {
      this.isProcessing = false;

      // Always schedule messages that arrived during this batch, including
      // when onBatchReady failed. The queue job was already acknowledged on
      // SSE receipt, so leaving these messages only in memory until a third
      // message happened to arrive stranded a durable user turn indefinitely.
      // `batchTimer` is null here: processBatch cleared it before setting
      // isProcessing, and addMessage never starts one while a batch is active.
      if (!this.stopped && this.messageQueue.length > 0) {
        logger.info(
          `Starting new batch window for ${this.messageQueue.length} queued messages`
        );
        this.batchTimer = setTimeout(() => {
          void this.processBatch().catch((error) => {
            logger.error("Error during batch processing:", error);
          });
        }, this.batchWindowMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
  }

  getPendingCount(): number {
    return this.messageQueue.length;
  }
}
