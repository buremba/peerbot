/**
 * The `thread_response` owner-gate uses attempt exhaustion as its drop policy:
 * a replica that does not hold the client's SSE throws to re-queue, and after
 * TERMINAL_DELIVERY_SEND_OPTS.retryLimit claims the row dead-letters.
 *
 * Dropping the row also drops the renderer's DURABLE side effects — above all
 * `resolveAutomationRunsByMessageIds`, without which an Automation run never
 * reaches a terminal state and hangs until the 2h stale sweep (observed in
 * prod: run 989823 on 2026-08-16, plus 20 other dead-letters since 07-28).
 *
 * This drives the REAL RunsQueue against Postgres to prove the two halves that
 * the unit tests cannot: the queue hands the handler its attempt budget, and
 * the budget it hands over lines up with the dead-letter rule in `runHandler`
 * (attempts + 1 >= max_attempts), so the consumer's final-attempt fallback
 * fires on exactly the claim before the drop.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunsQueue } from "../../gateway/infrastructure/queue/runs-queue";
import type { QueueJob } from "../../gateway/infrastructure/queue/types";
import { getDb } from "../../db/client";
import { cleanupTestDatabase } from "../setup/test-db";

const QUEUE = "thread_response";

describe("thread_response attempt budget reaches the handler", () => {
  const queue = new RunsQueue();

  beforeAll(async () => {
    await cleanupTestDatabase();
    await queue.start();
    await queue.createQueue(QUEUE);
  });

  afterAll(async () => {
    await queue.stop();
  });

  it("exposes attempt/maxAttempts and marks the pre-drop claim as final", async () => {
    const seen: Array<{ attempt?: number; maxAttempts?: number }> = [];
    const retryLimit = 3;

    let settle: () => void;
    const exhausted = new Promise<void>((resolve) => {
      settle = resolve;
    });

    await queue.work(QUEUE, async (job: QueueJob<unknown>) => {
      seen.push({ attempt: job.attempt, maxAttempts: job.maxAttempts });
      if (seen.length >= retryLimit) settle();
      // Mirror the owner-gate: throw so the row consumes its budget.
      throw new Error("no SSE owner on this replica");
    });

    const runId = await queue.send(
      QUEUE,
      {
        messageId: "m-budget-1",
        conversationId: "conv-budget-1",
        userId: "u-budget",
        teamId: "api",
        processedMessageIds: ["m-budget-1"],
        platformMetadata: { source: "direct-api" },
      },
      { retryLimit, retryDelay: 1 },
    );

    await exhausted;
    // Let runHandler finish marking the last attempt failed.
    await new Promise((r) => setTimeout(r, 750));

    // Every claim carries the budget...
    expect(seen.length).toBeGreaterThanOrEqual(retryLimit);
    for (const s of seen) {
      expect(s.maxAttempts).toBe(retryLimit);
      expect(typeof s.attempt).toBe("number");
    }
    // ...counting up from 0, so the LAST claim satisfies the same
    // `attempt + 1 >= maxAttempts` test the consumer uses.
    expect(seen[0]!.attempt).toBe(0);
    const last = seen[retryLimit - 1]!;
    expect(last.attempt! + 1).toBeGreaterThanOrEqual(last.maxAttempts!);
    // ...and no earlier claim looked final.
    for (const s of seen.slice(0, retryLimit - 1)) {
      expect(s.attempt! + 1).toBeLessThan(s.maxAttempts!);
    }

    // The row really did dead-letter after the budget ran out.
    const rows = await getDb()<{ status: string; attempts: number }>`
      SELECT status, attempts FROM public.runs WHERE id = ${Number(runId)}
    `;
    expect(rows[0]?.status).toBe("failed");
  }, 30_000);
});
