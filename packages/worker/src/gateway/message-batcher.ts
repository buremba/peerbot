/**
 * Message batching for grouping rapid messages
 */

import { createLogger } from "@lobu/core";
import type { QueuedMessage } from "./types";

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
  private isProcessing = false;
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly batchWindowMs: number;
  private readonly onBatchReady?: (messages: QueuedMessage[]) => Promise<void>;
  private hasProcessedInitialBatch = false;

  constructor(config: BatcherConfig = {}) {
    this.batchWindowMs = config.batchWindowMs ?? 2000; // 2 second window by default
    this.onBatchReady = config.onBatchReady;
  }

  async addMessage(message: QueuedMessage): Promise<void> {
    this.messageQueue.push(message);

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

  private async processBatch(): Promise<void> {
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

      // If more messages arrived during processing, start new batch
      if (this.messageQueue.length > 0) {
        if (this.batchTimer) {
          clearTimeout(this.batchTimer);
          this.batchTimer = null;
        }
        logger.info(
          `Starting new batch window for ${this.messageQueue.length} queued messages`
        );
        this.batchTimer = setTimeout(() => {
          void this.processBatch().catch((error) => {
            logger.error("Error during batch processing:", error);
          });
        }, this.batchWindowMs);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  stop(): void {
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
