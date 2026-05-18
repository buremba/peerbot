/**
 * Tier B: claim atomicity and sweep behavior for the PG-backed
 * pending-interaction store that backs the chat interaction bridge.
 *
 * The bridge moved its `Map<questionId, PendingQuestionEntry>` into
 * `public.pending_interactions` so a button click landing on pod B can
 * claim a question registered on pod A. Two things must hold:
 *   1. `claimPendingQuestion` is single-winner — two concurrent claims
 *      return the payload exactly once.
 *   2. `sweepStalePendingInteractions` only deletes rows older than the
 *      given max-age cutoff.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { getDb } from "../../db/client.js";
import {
  claimPendingQuestion,
  restashPendingQuestion,
  storePendingQuestion,
  sweepStalePendingInteractions,
} from "../connections/pending-interaction-store.js";
import type { PostedQuestion } from "../interactions.js";

function buildQuestion(id: string): PostedQuestion {
  return {
    id,
    teamId: undefined,
    channelId: "C1",
    conversationId: "C1",
    userId: "U1",
    platform: "slack",
    question: "go?",
    options: ["yes", "no"],
  } as PostedQuestion;
}

describe("pending-interaction-store", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("claim returns the stored payload exactly once", async () => {
    const q = buildQuestion("q-1");
    await storePendingQuestion(q.id, undefined, { question: q });

    const first = await claimPendingQuestion(q.id);
    expect(first?.question.id).toBe("q-1");

    const second = await claimPendingQuestion(q.id);
    expect(second).toBeNull();
  });

  test("restash makes a claimed question claimable again", async () => {
    const q = buildQuestion("q-restash");
    await storePendingQuestion(q.id, undefined, { question: q });
    await claimPendingQuestion(q.id);

    await restashPendingQuestion(q.id, undefined, { question: q });
    const reclaimed = await claimPendingQuestion(q.id);
    expect(reclaimed?.question.id).toBe("q-restash");
  });

  test("sweep deletes only rows older than the cutoff", async () => {
    const sql = getDb();
    const fresh = buildQuestion("q-fresh");
    const stale = buildQuestion("q-stale");
    await storePendingQuestion(fresh.id, undefined, { question: fresh });
    await storePendingQuestion(stale.id, undefined, { question: stale });

    // Backdate one row past the 24h cutoff.
    await sql`
      UPDATE pending_interactions
         SET created_at = now() - interval '48 hours'
       WHERE id = ${stale.id}
    `;

    const deleted = await sweepStalePendingInteractions();
    expect(deleted).toBe(1);

    // Fresh row is still claimable; stale row is gone.
    expect((await claimPendingQuestion(fresh.id))?.question.id).toBe("q-fresh");
    expect(await claimPendingQuestion(stale.id)).toBeNull();
  });
});
