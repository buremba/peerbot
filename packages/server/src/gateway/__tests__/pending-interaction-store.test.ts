/**
 * Tier B: claim atomicity, scoping, and sweep behavior for the PG-backed
 * pending-interaction store that backs the chat interaction bridge.
 *
 * The store backs the bridge's `Map<questionId, PendingQuestionEntry>`
 * with `public.pending_interactions`. Three properties matter:
 *   1. `claimPendingQuestion` is single-winner — two concurrent claims
 *      with matching scope return the payload exactly once.
 *   2. The scope tuple `(id, organization_id, connection_id,
 *      expected_user_id)` is enforced inside the SQL claim — mismatched
 *      org / connection / user clicks return null and DO NOT consume the
 *      row. These are the red→green checks that gate findings #1 (cross-
 *      tenant claim hole) and #3 (claim-then-auth race).
 *   3. `sweepStalePendingInteractions` only deletes rows older than the
 *      given max-age cutoff and returns the deleted ids so the bridge
 *      can sync its local SentMessage cache.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { getDb } from "../../db/client.js";
import {
  claimPendingQuestion,
  storePendingQuestion,
  sweepStalePendingInteractions,
} from "../connections/pending-interaction-store.js";
import type { PostedQuestion } from "../interactions.js";

const ORG_A = "org-a";
const ORG_B = "org-b";
const CONN_A = "conn-a";
const CONN_B = "conn-b";
const USER_A = "U_A";
const USER_B = "U_B";

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

describe("pending-interaction-store", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    await seedOrg(ORG_B);
  });

  test("matching-scope claim returns the stored payload exactly once", async () => {
    const q = buildQuestion("q-1");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const first = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(first?.question.id).toBe("q-1");

    const second = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(second).toBeNull();
  });

  // Finding #1 — cross-tenant claim hole.
  //
  // Red on the previous commit: `claimPendingQuestion(id)` was keyed by
  // `id` only, so org B could consume org A's row by replaying the id.
  // Green here: scope by `organization_id` blocks the claim, AND the
  // row stays untouched so the rightful org can still claim it.
  test("cross-tenant claim is rejected and does NOT consume the row", async () => {
    const q = buildQuestion("q-cross-tenant");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const wrongOrg = await claimPendingQuestion(q.id, ORG_B, CONN_A, USER_A);
    expect(wrongOrg).toBeNull();

    const rightful = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(rightful?.question.id).toBe("q-cross-tenant");
  });

  test("cross-connection claim is rejected and does NOT consume the row", async () => {
    const q = buildQuestion("q-cross-conn");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const wrongConn = await claimPendingQuestion(q.id, ORG_A, CONN_B, USER_A);
    expect(wrongConn).toBeNull();

    const rightful = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(rightful?.question.id).toBe("q-cross-conn");
  });

  // Finding #3 — claim-then-auth race.
  //
  // Red on the previous commit: the handler did `claimQuestion(id)`
  // first, then compared `author.userId` against the row's userId, then
  // async-restashed on mismatch. A crash between claim and restash
  // permanently consumed the row until the 24h sweep.
  // Green here: `expected_user_id` is part of the SQL claim, so a wrong-
  // user click returns null without ever setting `claimed_at`. No
  // restash is needed because no claim happens.
  test("wrong-user click is rejected and does NOT consume the row", async () => {
    const q = buildQuestion("q-wrong-user", USER_A);
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const wrongUser = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_B);
    expect(wrongUser).toBeNull();

    const rightful = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(rightful?.question.id).toBe("q-wrong-user");
  });

  test("sweep deletes only rows older than the cutoff and returns their ids", async () => {
    const sql = getDb();
    const fresh = buildQuestion("q-fresh");
    const stale = buildQuestion("q-stale");
    await storePendingQuestion(fresh.id, ORG_A, CONN_A, USER_A, {
      question: fresh,
    });
    await storePendingQuestion(stale.id, ORG_A, CONN_A, USER_A, {
      question: stale,
    });

    // Backdate one row past the 24h cutoff.
    await sql`
      UPDATE pending_interactions
         SET created_at = now() - interval '48 hours'
       WHERE id = ${stale.id}
    `;

    const deletedIds = await sweepStalePendingInteractions();
    expect(deletedIds).toEqual(["q-stale"]);

    // Fresh row is still claimable; stale row is gone.
    expect(
      (await claimPendingQuestion(fresh.id, ORG_A, CONN_A, USER_A))?.question.id
    ).toBe("q-fresh");
    expect(
      await claimPendingQuestion(stale.id, ORG_A, CONN_A, USER_A)
    ).toBeNull();
  });
});
