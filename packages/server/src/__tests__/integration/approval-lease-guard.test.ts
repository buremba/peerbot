/**
 * Approval-run lease guards.
 *
 * A builder approval claims the run, then runs the family's `apply` OUTSIDE
 * that transaction — a slow, network-bound call. Until now the claim flipped
 * the run to `running` without taking a lease, so across the whole of that
 * call the run sat approved, running and UNOWNED: exactly the row the
 * stale-run reaper terminalizes and a second approve re-approves. Whichever
 * write landed last won, and an already-applied mutation could be relabelled.
 *
 * Two guards close it, and both are pinned here:
 *
 *  - `claimBuilderRun` takes the lease in the statement that approves the run,
 *    so there is no unowned window to lose it in.
 *  - `terminalizeApprovalRunCompleted` fences on an owner the caller must
 *    supply. Its two RECOVERY callers — `tryReconcileTerminalization` and the
 *    stalled-execution reaper — finalize runs they did not claim, so they pass
 *    the owner they READ off the row; a re-claim between that read and the
 *    write makes the write lose instead of overwriting the new owner.
 *
 * `null` is a real assertion here, not an escape hatch: it means "this run is
 * still unowned", which is what a row claimed before the gateway took leases
 * looks like. It is NOT "skip the check".
 */

import type { Context } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import { terminalizeApprovalRunCompleted } from "../../tools/admin/approval-events";
import type { ToolContext } from "../../tools/registry";
import { insertEvent } from "../../utils/insert-event";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { ownerToolContext, seedOwnerContext } from "../setup/test-fixtures";

const THIEF = "some-other-replica";
const CARD = { title: "t — completed", content: "c" };

/** A pending agent_ask run + its pending card, the shape `queueAgentAsk` makes. */
async function seedAgentAskRun(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, action_input,
			created_by_user_id, approval_status, status, created_at
		) VALUES (
			${organizationId}, 'internal', 'agent_ask',
			${sql.json({ question: "Ship it?", input_schema: { type: "object" } })},
			${userId}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	await insertEvent({
		entityIds: [],
		organizationId,
		originId: `run_${runId}_pending`,
		title: "Ship it?",
		content: null,
		semanticType: "operation",
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		interactionInputSchema: { type: "object" },
		metadata: { tool: "notify", action_key: "agent_ask", run_id: runId },
		authorName: "agent",
	});
	return runId;
}

/** A run already claimed and mid-apply, the state a terminal write lands on. */
async function seedClaimedRun(
	organizationId: string,
	claimedBy: string | null,
): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, approval_status, status,
			claimed_by, claimed_at, created_at
		) VALUES (
			${organizationId}, 'action', 'demo.op', 'approved', 'running',
			${claimedBy}, NOW(), NOW()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	await insertEvent({
		entityIds: [],
		organizationId,
		originId: `run_${runId}_confirmed`,
		title: "demo.op — executing",
		content: null,
		semanticType: "operation",
		runId,
		interactionType: "approval",
		// The card's persisted status for a 'confirmed' transition; 'confirmed'
		// itself is not one of the five the events check constraint allows.
		interactionStatus: "approved",
		metadata: { action_key: "demo.op", run_id: runId },
		authorName: "agent",
	});
	return runId;
}

async function readRun(runId: number) {
	const [row] = await getTestDb()<{
		status: string;
		claimed_by: string | null;
		action_output: Record<string, unknown> | null;
	}>`SELECT status, claimed_by, action_output FROM runs WHERE id = ${runId}`;
	return row;
}

describe("approval lease guards", () => {
	let orgId: string;
	let userId: string;
	let humanCtx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user } = await seedOwnerContext({ orgName: "Approval Lease Org" });
		orgId = org.id;
		userId = user.id;
		humanCtx = ownerToolContext(orgId, userId);
		humanCtx.baseUrl = "https://gateway.test/lobu";
	});

	it("approving a builder run takes the lease in the same statement", async () => {
		const runId = await seedAgentAskRun(orgId, userId);
		const approved = (await manageOperations(
			{ action: "approve", run_id: runId, input: { answer: "yes" } },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; error?: string };
		expect(approved.error).toBeUndefined();
		expect(approved.approved).toBe(true);

		// The lease outlives the run: it is what every terminal write for this
		// decision fences on, so it must be the gateway's own owner and never null.
		const run = await readRun(runId);
		expect(run.claimed_by).toMatch(/^gateway-inline-/);
		expect(String(run.status)).toBe("completed");
	});

	it("does NOT terminalize a run whose lease moved since it was read", async () => {
		const owner = "gateway-inline-original";
		const runId = await seedClaimedRun(orgId, owner);
		// The recovery caller read `owner`; the run is re-claimed before its write.
		await getTestDb()`UPDATE runs SET claimed_by = ${THIEF} WHERE id = ${runId}`;

		const eventId = await terminalizeApprovalRunCompleted(
			runId,
			orgId,
			{ recovered: true },
			CARD,
			null,
			owner,
		);

		expect(eventId).toBeNull();
		const run = await readRun(runId);
		expect(run.claimed_by).toBe(THIEF);
		expect(String(run.status)).toBe("running");
		expect(run.action_output).toBeNull();
	});

	it("terminalizes a run still held by the owner the caller read", async () => {
		const owner = "gateway-inline-original";
		const runId = await seedClaimedRun(orgId, owner);

		const eventId = await terminalizeApprovalRunCompleted(
			runId,
			orgId,
			{ recovered: true },
			CARD,
			null,
			owner,
		);

		expect(eventId).not.toBeNull();
		const run = await readRun(runId);
		expect(String(run.status)).toBe("completed");
		expect(run.action_output).toEqual({ recovered: true });
	});

	it("treats a null owner as 'still unowned', not as 'skip the check'", async () => {
		// A row claimed before the gateway took leases: the recovery caller reads
		// null and must still finalize it.
		const legacyRunId = await seedClaimedRun(orgId, null);
		expect(
			await terminalizeApprovalRunCompleted(
				legacyRunId,
				orgId,
				{ recovered: true },
				CARD,
				null,
				null,
			),
		).not.toBeNull();
		expect(String((await readRun(legacyRunId)).status)).toBe("completed");

		// The same null must NOT wave through a run someone now owns.
		const ownedRunId = await seedClaimedRun(orgId, THIEF);
		expect(
			await terminalizeApprovalRunCompleted(
				ownedRunId,
				orgId,
				{ recovered: true },
				CARD,
				null,
				null,
			),
		).toBeNull();
		const owned = await readRun(ownedRunId);
		expect(String(owned.status)).toBe("running");
		expect(owned.action_output).toBeNull();
	});
});
