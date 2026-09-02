/**
 * Claim semantics for the `pending-tool` store, against real Postgres.
 *
 * The interactive approve path used to peek, decide in JS, then delete. Folding
 * that into one statement is a consolidation rather than a bug fix, so these
 * tests exist to pin what it has to keep doing: a row is claimed exactly
 * once, a headless Automation row is refused AND survives the refusal, the
 * Automation shape is recognised only as a suffix, and a caller that loses a
 * concurrent claim is told the row is gone.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
  claimPendingTool,
  storePendingTool,
} from "../auth/mcp/pending-tool-store.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

/** A pending invocation carrying whatever conversation id the case needs. */
function invocation(conversationId: string) {
  return {
    mcpId: "lobu-memory",
    toolName: "run_sdk",
    args: { script: "return 1" },
    agentId: "agent-claim",
    userId: "U_CLAIM",
    organizationId: "org-claim",
    conversationId,
  };
}

async function rowExists(requestId: string): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    SELECT 1 FROM oauth_states WHERE id = ${requestId}
  `;
  return rows.length > 0;
}

describe("claimPendingTool", () => {
  test("claims an interactive row exactly once", async () => {
    await storePendingTool("ta_interactive", invocation("slack:dm:1"), 600);

    const first = await claimPendingTool("ta_interactive");
    expect(first).toMatchObject({
      ok: true,
      invocation: { toolName: "run_sdk", conversationId: "slack:dm:1" },
    });

    // The row is consumed, so a webhook retry of the same click no-ops.
    expect(await claimPendingTool("ta_interactive")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await rowExists("ta_interactive")).toBe(false);
  });

  test("refuses a headless Automation row and leaves it in place", async () => {
    const conversationId = "agent-claim_automation_12_run_345";
    await storePendingTool("ta_headless", invocation(conversationId), 600);

    expect(await claimPendingTool("ta_headless")).toEqual({
      ok: false,
      reason: "automation_headless",
    });
    // Refusing must not consume it: the Automation run's own approval path
    // still has to find this row.
    expect(await rowExists("ta_headless")).toBe(true);
  });

  test("an Automation-shaped id only matches at the end of the conversation id", async () => {
    await storePendingTool(
      "ta_suffixed",
      invocation("agent_automation_12_run_345:thread:9"),
      600,
    );

    expect(await claimPendingTool("ta_suffixed")).toMatchObject({ ok: true });
  });

  test("reports missing for an unknown id and for an expired row", async () => {
    expect(await claimPendingTool("ta_nonexistent")).toEqual({
      ok: false,
      reason: "missing",
    });

    await storePendingTool("ta_expired", invocation("slack:dm:2"), -60);
    expect(await claimPendingTool("ta_expired")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("a concurrent double-click yields one claim and one missing", async () => {
    await storePendingTool("ta_raced", invocation("slack:dm:3"), 600);

    const results = await Promise.all([
      claimPendingTool("ta_raced"),
      claimPendingTool("ta_raced"),
    ]);

    const claimed = results.filter((r) => r.ok);
    expect(claimed).toHaveLength(1);
    // A lost claim reports `missing`, never the headless refusal: the row was
    // claimable, somebody else just got there first.
    const loser = results.find((r) => !r.ok);
    expect(loser).toEqual({ ok: false, reason: "missing" });
  });

  test("round-trips a paired admin grant and drops an unpaired one", async () => {
    await storePendingTool(
      "ta_paired",
      {
        ...invocation("slack:dm:4"),
        adminTools: ["run_sdk"],
        adminActorUserId: "auth-1",
      },
      600,
    );
    expect(await claimPendingTool("ta_paired")).toMatchObject({
      ok: true,
      invocation: { adminTools: ["run_sdk"], adminActorUserId: "auth-1" },
    });

    // An allowlist with no verified actor must resume as a plain, non-admin
    // call. PendingAdminGrant makes that shape unconstructible in TypeScript,
    // so the only way it reaches the claim is the way it would in production:
    // a row written by an older or tampered writer. Insert it as one.
    const sql = getDb();
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        'ta_unpaired',
        'pending-tool',
        ${sql.json({ ...invocation("slack:dm:5"), adminTools: ["run_sdk"] })},
        now() + interval '10 minutes'
      )
    `;
    const unpaired = await claimPendingTool("ta_unpaired");
    expect(unpaired.ok).toBe(true);
    expect(unpaired.ok && unpaired.invocation.adminTools).toBeUndefined();
    expect(unpaired.ok && unpaired.invocation.adminActorUserId).toBeUndefined();
  });
});
