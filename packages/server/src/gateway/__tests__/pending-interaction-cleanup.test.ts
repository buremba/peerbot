/**
 * Cleanup-path tests for `pending_interactions`:
 *
 *   - Retry-on-conflict preserves `created_at`. Pre-fix, `ON CONFLICT
 *     … created_at = now()` reset the 24h TTL clock on every webhook retry,
 *     so a misbehaving retry loop could keep the same row alive
 *     indefinitely. Post-fix: `created_at` survives retries.
 *   - `sweepStalePendingInteractions` honours its LIMIT. Pre-fix the DELETE
 *     was unbounded, so a multi-million-row backlog could lock the table.
 *     Post-fix: default 1000 / configurable cap, remaining rows drain
 *     across subsequent cycles.
 *   - `deletePendingQuestion` hard-deletes the row instead of just setting
 *     `claimed_at`. Pre-fix, the post-failure drop path called
 *     `claimPendingQuestion` (UPDATE), leaving a stale row sitting there
 *     until the 24h sweep. Post-fix: row count goes to 0 immediately.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
  claimPendingQuestion,
  deletePendingQuestion,
  storePendingQuestion,
  sweepStalePendingInteractions,
} from "../connections/pending-interaction-store.js";
import type { PostedQuestion } from "../interactions.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const ORG_A = "org-a";
const CONN_A = "conn-a";
const USER_A = "U_A";

async function seedOrg(id: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${id}, ${id}, ${id})
    ON CONFLICT (id) DO NOTHING
  `;
}

function buildQuestion(id: string, userId = USER_A): PostedQuestion {
  return {
    id,
    teamId: undefined,
    channelId: "C1",
    conversationId: "C1",
    userId,
    platform: "slack",
    question: "go?",
    options: ["yes", "no"],
  } as PostedQuestion;
}

describe("pending-interaction-store cleanup paths", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
  });

  // Fix #3 — ON CONFLICT no longer resets created_at.
  test("retry storePendingQuestion preserves the original created_at", async () => {
    const sql = getDb();
    const q = buildQuestion("q-retry");

    // First persist.
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });
    const initial = await sql<{ created_at: Date }>`
      SELECT created_at FROM pending_interactions WHERE id = ${q.id}
    `;
    const originalCreatedAt = new Date(initial[0]!.created_at).getTime();

    // Backdate the row so a "retry preserves created_at" assertion is
    // distinguishable from "row was just inserted now()". Without this the
    // pre/post-fix versions could both end up at now() within the same ms.
    await sql`
      UPDATE pending_interactions
         SET created_at = now() - interval '1 hour'
       WHERE id = ${q.id}
    `;
    const backdated = await sql<{ created_at: Date }>`
      SELECT created_at FROM pending_interactions WHERE id = ${q.id}
    `;
    const backdatedTs = new Date(backdated[0]!.created_at).getTime();
    expect(backdatedTs).toBeLessThan(originalCreatedAt);

    // Webhook retry — same id, same scope, slightly different payload.
    const retry = { ...q, question: "go? (retry)" };
    await storePendingQuestion(retry.id, ORG_A, CONN_A, USER_A, {
      question: retry,
    });

    const after = await sql<{ created_at: Date; claimed_at: Date | null }>`
      SELECT created_at, claimed_at
      FROM pending_interactions WHERE id = ${q.id}
    `;
    const afterTs = new Date(after[0]!.created_at).getTime();

    // Pre-fix: this assertion fails — the ON CONFLICT clause moved
    // created_at to now() and `afterTs` ≈ now() ≫ `backdatedTs`.
    // Post-fix: created_at is unchanged across retries.
    expect(afterTs).toBe(backdatedTs);
    // claimed_at is still reset on conflict so a legitimate retry can
    // be claimed.
    expect(after[0]!.claimed_at).toBeNull();
  });

  // Fix #6 — bounded sweep.
  test("sweepStalePendingInteractions honours the LIMIT and remainder drains next cycle", async () => {
    const sql = getDb();
    const total = 25;
    for (let i = 0; i < total; i++) {
      const q = buildQuestion(`q-${i}`);
      await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });
    }
    // Backdate all rows past the cutoff.
    await sql`
      UPDATE pending_interactions
         SET created_at = now() - interval '48 hours'
    `;

    // First sweep caps at LIMIT=10.
    const first = await sweepStalePendingInteractions(
      24 * 60 * 60 * 1000,
      10
    );
    expect(first).toHaveLength(10);

    const remainingAfterFirst = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions
    `;
    expect(remainingAfterFirst[0]!.c).toBe(total - 10);

    // Second sweep drains the rest (LIMIT > remaining).
    const second = await sweepStalePendingInteractions(
      24 * 60 * 60 * 1000,
      100
    );
    expect(second).toHaveLength(total - 10);

    const remainingAfterSecond = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions
    `;
    expect(remainingAfterSecond[0]!.c).toBe(0);
  });

  // Fix #7 — drop-on-post-failure uses DELETE not claim.
  test("deletePendingQuestion hard-deletes the row, not claim-then-leave", async () => {
    const sql = getDb();
    const q = buildQuestion("q-drop");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const beforeDrop = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions WHERE id = ${q.id}
    `;
    expect(beforeDrop[0]!.c).toBe(1);

    const deleted = await deletePendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(deleted).toBe(true);

    // The whole row is gone. A subsequent claim sees no row.
    const afterDrop = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions WHERE id = ${q.id}
    `;
    expect(afterDrop[0]!.c).toBe(0);
    expect(await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A)).toBeNull();
  });

  // Scoping invariant of deletePendingQuestion — same safety as claim.
  test("deletePendingQuestion is scoped by (org, connection, user) — leaked id alone cannot delete", async () => {
    const sql = getDb();
    await seedOrg("org-b");
    const q = buildQuestion("q-scope");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    // Wrong org — no row deleted.
    expect(
      await deletePendingQuestion(q.id, "org-b", CONN_A, USER_A)
    ).toBe(false);
    // Wrong connection — no row deleted.
    expect(
      await deletePendingQuestion(q.id, ORG_A, "conn-other", USER_A)
    ).toBe(false);
    // Wrong user — no row deleted.
    expect(
      await deletePendingQuestion(q.id, ORG_A, CONN_A, "U_B")
    ).toBe(false);

    const stillThere = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions WHERE id = ${q.id}
    `;
    expect(stillThere[0]!.c).toBe(1);

    // Correct scope — deletes.
    expect(
      await deletePendingQuestion(q.id, ORG_A, CONN_A, USER_A)
    ).toBe(true);
  });
});
