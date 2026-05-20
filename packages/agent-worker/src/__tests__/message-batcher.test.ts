/**
 * Hardening tests for MessageBatcher.
 *
 * Covers:
 * - First message is processed immediately (no batch window)
 * - Subsequent messages enter the batch window
 * - Messages queued during processing are handled after the current batch
 * - stop() cancels a pending batch timer
 * - Messages are sorted by timestamp before delivery
 * - onBatchReady receives combined messages in order
 * - getPendingCount and isCurrentlyProcessing visibility
 * - Error in onBatchReady is caught, isProcessing is reset to false
 */

import { describe, expect, test } from "bun:test";
import type { QueuedMessage } from "@lobu/core";
import { MessageBatcher } from "../gateway/message-batcher";

function makeMsg(
  messageId: string,
  messageText = "hello",
  timestamp = Date.now()
): QueuedMessage {
  return {
    timestamp,
    payload: {
      botId: "bot",
      userId: "user-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      platform: "api",
      channelId: "chan-1",
      messageId,
      messageText,
      platformMetadata: {},
      agentOptions: {},
    },
  };
}

// ---------------------------------------------------------------------------
// First message — immediate processing
// ---------------------------------------------------------------------------

describe("MessageBatcher — first message processed immediately", () => {
  test("onBatchReady called synchronously (within the addMessage await) for first message", async () => {
    const processed: string[][] = [];
    const batcher = new MessageBatcher({
      onBatchReady: async (msgs) => {
        processed.push(msgs.map((m) => m.payload.messageId));
      },
      batchWindowMs: 5000, // long window — should not matter for first message
    });

    await batcher.addMessage(makeMsg("msg-1", "hello", 1000));
    expect(processed).toHaveLength(1);
    expect(processed[0]).toEqual(["msg-1"]);
  });

  test("getPendingCount is 0 after first message is processed", async () => {
    const batcher = new MessageBatcher({
      onBatchReady: async () => undefined,
    });
    await batcher.addMessage(makeMsg("msg-1"));
    expect(batcher.getPendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Messages during processing — queued for next batch
// ---------------------------------------------------------------------------

describe("MessageBatcher — message queued during processing", () => {
  test("message added while onBatchReady is running is queued and processed after", async () => {
    const batches: string[][] = [];
    let resolveBatch: (() => void) | null = null;

    const batcher = new MessageBatcher({
      batchWindowMs: 50,
      onBatchReady: async (msgs) => {
        batches.push(msgs.map((m) => m.payload.messageId));
        if (batches.length === 1) {
          // Signal that first batch is about to complete; test adds a message now
          await new Promise<void>((r) => {
            resolveBatch = r;
          });
        }
      },
    });

    // Start first batch
    const firstBatch = batcher.addMessage(makeMsg("msg-1", "first", 1));
    // Wait until onBatchReady is blocking on the promise
    await new Promise((r) => setTimeout(r, 5));

    // Add message while processing — should queue for next batch
    batcher.addMessage(makeMsg("msg-2", "second", 2)).catch(() => undefined);
    expect(batcher.getPendingCount()).toBe(1);

    // Release the first onBatchReady
    resolveBatch?.();
    await firstBatch;

    // Wait for the second batch timer to fire
    await new Promise((r) => setTimeout(r, 200));

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(["msg-1"]);
    expect(batches[1]).toEqual(["msg-2"]);
  });
});

// ---------------------------------------------------------------------------
// Batch window — messages collected and sorted
// ---------------------------------------------------------------------------

describe("MessageBatcher — batch window collects messages by timestamp", () => {
  test("two messages added within batch window arrive in timestamp order", async () => {
    const batches: QueuedMessage[][] = [];

    const batcher = new MessageBatcher({
      batchWindowMs: 50,
      onBatchReady: async (msgs) => {
        batches.push(msgs);
      },
    });

    // First message → triggers immediate processing (consumes initial batch)
    await batcher.addMessage(makeMsg("msg-1", "first", 1));

    // Now send two messages quickly within the batch window
    await batcher.addMessage(makeMsg("msg-3", "third", 300));
    await batcher.addMessage(makeMsg("msg-2", "second", 200));

    // Wait for the batch window to fire
    await new Promise((r) => setTimeout(r, 200));

    expect(batches).toHaveLength(2);
    // Second batch should contain both messages sorted by timestamp
    const secondBatch = batches[1];
    expect(secondBatch).toHaveLength(2);
    expect(secondBatch?.[0]?.payload.messageId).toBe("msg-2"); // ts=200 < ts=300
    expect(secondBatch?.[1]?.payload.messageId).toBe("msg-3");
  });
});

// ---------------------------------------------------------------------------
// stop() cancels pending timer
// ---------------------------------------------------------------------------

describe("MessageBatcher — stop()", () => {
  test("stop() after first message prevents queued timer from firing", async () => {
    const processed: string[][] = [];
    const batcher = new MessageBatcher({
      batchWindowMs: 50,
      onBatchReady: async (msgs) => {
        processed.push(msgs.map((m) => m.payload.messageId));
      },
    });

    // First message processed immediately
    await batcher.addMessage(makeMsg("msg-1", "first", 1));

    // Add a second message which starts the batch timer
    await batcher.addMessage(makeMsg("msg-2", "second", 2));
    // Stop before the timer fires
    batcher.stop();

    // Wait longer than the batch window
    await new Promise((r) => setTimeout(r, 200));

    // Only the first batch should have been delivered
    expect(processed).toHaveLength(1);
    expect(processed[0]).toEqual(["msg-1"]);
  });

  test("getPendingCount remains 1 after stop() if message was queued", async () => {
    const batcher = new MessageBatcher({
      batchWindowMs: 50,
      onBatchReady: async () => undefined,
    });

    await batcher.addMessage(makeMsg("msg-1", "first", 1));
    await batcher.addMessage(makeMsg("msg-2", "second", 2));

    batcher.stop();

    // The timer was cleared; the queued message is still in the queue
    expect(batcher.getPendingCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isCurrentlyProcessing visibility
// ---------------------------------------------------------------------------

describe("MessageBatcher — isCurrentlyProcessing", () => {
  test("isCurrentlyProcessing is true during onBatchReady and false after", async () => {
    const states: boolean[] = [];
    let markProcessingDone: (() => void) | null = null;

    const batcher = new MessageBatcher({
      onBatchReady: async () => {
        states.push(batcher.isCurrentlyProcessing());
        await new Promise<void>((r) => {
          markProcessingDone = r;
        });
      },
    });

    const p = batcher.addMessage(makeMsg("msg-1", "hello", 1));
    // Give the event loop a tick so onBatchReady starts
    await new Promise((r) => setTimeout(r, 5));

    expect(batcher.isCurrentlyProcessing()).toBe(true);
    markProcessingDone?.();
    await p;
    expect(batcher.isCurrentlyProcessing()).toBe(false);
    expect(states).toContain(true);
  });
});

// ---------------------------------------------------------------------------
// Error in onBatchReady resets isProcessing
// ---------------------------------------------------------------------------

describe("MessageBatcher — error resilience", () => {
  test("error thrown in onBatchReady resets isProcessing to false", async () => {
    const batcher = new MessageBatcher({
      onBatchReady: async () => {
        throw new Error("batch processing failed");
      },
    });

    // addMessage is fire-and-forget via setTimeout for subsequent batches,
    // but first message is awaited synchronously — error is swallowed in the
    // private processBatch() try/finally.
    try {
      await batcher.addMessage(makeMsg("msg-1", "hello", 1));
    } catch {
      // may or may not propagate depending on implementation path
    }

    // After any error path, isProcessing must be false
    expect(batcher.isCurrentlyProcessing()).toBe(false);
  });
});
