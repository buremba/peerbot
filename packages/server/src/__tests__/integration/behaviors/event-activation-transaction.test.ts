import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	findMatchingBehaviorActivations,
	queueBehaviorActivations,
} from "../../../behaviors/activation";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("Behavior activation transactionality", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	/**
	 * The chat bridge queues activations without a caller-owned transaction.
	 * Replica safety of createBehaviorEventRun depends on its per-Behavior
	 * advisory lock and FOR UPDATE row locks being held across statements —
	 * i.e. the queueing path must open a real transaction, not run each
	 * statement in autocommit (where both locks release at statement end).
	 *
	 * Deterministic probe: park a second transaction on the pending run's row
	 * lock so the coalesce SELECT ... FOR UPDATE blocks at a known point, then
	 * observe from a third connection whether the blocked backend still holds
	 * the advisory lock. In autocommit it has already released it.
	 */
	it("holds the per-Behavior advisory lock across the coalesce read and never drops the signal", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug: "transactional-coalesce",
				name: "Transactional coalesce",
				prompt: "Summarize changed pull requests.",
				agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						connector_key: "github",
						connection_id: connection.id,
						event_types: ["pull_request.updated"],
						execution: "window",
						active_run: "coalesce",
						output: "silent",
					},
				],
			},
			{} as Env,
			ctx
		);
		if (created.action !== "create" || !("behavior_id" in created)) {
			throw new Error("Behavior creation did not complete");
		}
		const behaviorId = Number(created.behavior_id);
		const baseSignal = {
			connector_key: "github",
			connection_id: connection.id,
			event_type: "pull_request.updated",
			label: "PR changed",
			input_text: "A pull request changed.",
		};
		const matches = await findMatchingBehaviorActivations(org.id, {
			...baseSignal,
			delivery_id: "event:tx:1",
		});
		expect(matches).toHaveLength(1);

		const [seeded] = await queueBehaviorActivations({
			matches,
			signal: { ...baseSignal, delivery_id: "event:tx:1" },
		});
		expect(seeded).toMatchObject({ created: true, disposition: "queued" });
		const pendingRunId = seeded.runId;

		const sql = getTestDb();
		let releaseRowLock = () => {};
		const rowLockGate = new Promise<void>((resolve) => {
			releaseRowLock = resolve;
		});
		let rowLockHeld = () => {};
		const rowLockReady = new Promise<void>((resolve) => {
			rowLockHeld = resolve;
		});
		// Simulates a claimer that takes the run's row lock without the
		// advisory lock (e.g. an old pod during a rolling deploy).
		const claimer = sql.begin(async (tx) => {
			await tx`SELECT id FROM runs WHERE id = ${pendingRunId} FOR UPDATE`;
			rowLockHeld();
			await rowLockGate;
			await tx`UPDATE runs SET status = 'claimed' WHERE id = ${pendingRunId}`;
		});
		await rowLockReady;

		const queueing = queueBehaviorActivations({
			matches,
			signal: { ...baseSignal, delivery_id: "event:tx:2" },
		});

		let blockedPid: number | null = null;
		let advisoryHeldWhileBlocked = false;
		try {
			for (let attempt = 0; attempt < 400 && blockedPid == null; attempt++) {
				const waiting = await sql`
					SELECT pid
					FROM pg_stat_activity
					WHERE wait_event_type = 'Lock'
					  AND query LIKE '%FOR UPDATE%'
					  AND query LIKE '%runs%'
				`;
				if (waiting.length > 0) {
					blockedPid = Number(waiting[0]?.pid);
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			if (blockedPid != null) {
				const advisory = await sql`
					SELECT 1
					FROM pg_locks
					WHERE pid = ${blockedPid}
					  AND locktype = 'advisory'
					  AND granted
				`;
				advisoryHeldWhileBlocked = advisory.length > 0;
			}
		} finally {
			releaseRowLock();
		}
		await claimer;
		const [requeued] = await queueing;

		expect(blockedPid).not.toBeNull();
		expect(advisoryHeldWhileBlocked).toBe(true);

		// The concurrently-claimed run must not swallow the second signal: the
		// coalesce merge misses (run left 'pending'), so a fresh run is queued.
		expect(requeued).toMatchObject({ created: true, disposition: "queued" });
		const runs = await sql`
			SELECT id, status, approved_input
			FROM runs
			WHERE behavior_id = ${behaviorId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(2);
		expect(runs[0]?.status).toBe("claimed");
		expect(runs[0]?.approved_input).toMatchObject({
			delivery_ids: ["event:tx:1"],
		});
		expect(runs[1]?.status).toBe("pending");
		expect(runs[1]?.approved_input).toMatchObject({
			delivery_ids: ["event:tx:2"],
		});
	});
});
