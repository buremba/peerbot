/**
 * Approval-run TRANSITION atomicity — a decision's `runs` write and its
 * superseding card event must commit together.
 *
 * #2033 fixed the QUEUE path (run + pending approval event in one tx, see
 * operations-approval-event-atomicity.test.ts). This covers the far end: when
 * a human approves and the operation completes inline, the terminal
 * `runs.status='completed'` write and the 'completed' card supersede must be
 * atomic. Forced failure of the completed-event INSERT must roll the run's
 * terminal state back too — today the runs write commits while the card stays
 * at 'confirmed' (the agent reads `runs.action_output` via get_run; the UI card
 * reads the event; they diverge).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { Env } from "../../index";
import { queueAgentAsk } from "../../notifications/ask";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { insertEvent } from "../../utils/insert-event";
import { completeActionRun } from "../../worker-api";
import { failClaimedWorkerRun } from "../../worker-api/poll";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
	ownerToolContext,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR = "demo.ops.transition.atomic";

// Force a REAL failure of ONLY the terminal 'completed' card INSERT. The
// 'confirmed' event (the approval claim) writes `interaction_status='approved'`,
// so it must still succeed — the failure is isolated to the terminal phase, the
// exact divergence the two-phase atomicity fixes. This is a DB-level trigger,
// not a module mock, so it works under this suite's `isolate:false` shared
// registry.
const FAIL_COMPLETED_TRIGGER = `
CREATE OR REPLACE FUNCTION test_fail_terminal_approval_event() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'completed' THEN
    RAISE EXCEPTION 'simulated terminal approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_terminal_approval_event_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_terminal_approval_event();
`;
const DROP_FAIL_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_terminal_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_terminal_approval_event();
`;
const FAIL_FAILED_TRIGGER = `
CREATE OR REPLACE FUNCTION test_fail_failed_approval_event() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'failed' THEN
    RAISE EXCEPTION 'simulated failed approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_failed_approval_event_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_failed_approval_event();
`;
const DROP_FAIL_FAILED_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_failed_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_failed_approval_event();
`;

// Force the QUEUE-path pending card INSERT to fail so the run INSERT + card
// creation must commit atomically (or not at all).
const FAIL_PENDING_TRIGGER = `
CREATE OR REPLACE FUNCTION test_fail_pending_approval_event() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'pending' THEN
    RAISE EXCEPTION 'simulated pending approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_pending_approval_event_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_pending_approval_event();
`;
const DROP_FAIL_PENDING_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_pending_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_pending_approval_event();
`;

/**
 * Seed a pending agent-ask run + its pending approval card, exactly the shape
 * `queueAgentAsk` produces (legacy ask: no input_schema_validation_version, so
 * approve's validateInput passes without schema enforcement).
 */
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
			${sql.json({
				question: "Should we ship the staging change?",
				input_schema: { type: "object" },
			})},
			${userId}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	await insertEvent({
		entityIds: [],
		organizationId,
		originId: `run_${runId}_pending`,
		title: "Should we ship the staging change?",
		content: null,
		semanticType: "operation",
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		interactionInputSchema: { type: "object" },
		metadata: {
			tool: "notify",
			action_key: "agent_ask",
			question: "Should we ship the staging change?",
			status: "pending_approval",
			run_id: runId,
		},
		authorName: "agent",
	});
	return runId;
}

/** Minimal worker context for driving the REAL completeActionRun handler. */
function mockWorkerCtx(body: unknown): {
	ctx: Context<{ Bindings: Env }>;
	result: () => { body: unknown; status: number };
} {
	let captured: { body: unknown; status: number } = {
		body: undefined,
		status: 200,
	};
	const ctx = {
		req: { json: async () => body },
		var: {},
		json: (b: unknown, status?: number) => {
			captured = { body: b, status: status ?? 200 };
			return captured as unknown as Response;
		},
	} as unknown as Context<{ Bindings: Env }>;
	return { ctx, result: () => captured };
}

async function currentApprovalCard(
	runId: number,
	organizationId: string,
): Promise<{ interaction_status: string } | undefined> {
	const rows = await getTestDb()<{ interaction_status: string }>`
		SELECT interaction_status FROM current_event_records
		WHERE run_id = ${runId} AND organization_id = ${organizationId}
			AND semantic_type = 'operation' AND interaction_type = 'approval'
	`;
	return rows[0];
}

describe("approval-run transition atomicity", () => {
	let orgId: string;
	let userId: string;
	let humanCtx: ToolContext;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user } = await seedOwnerContext({
			orgName: "Approval Transition Org",
		});
		orgId = org.id;
		userId = user.id;
		humanCtx = ownerToolContext(orgId, userId);
		humanCtx.baseUrl = "https://gateway.test/lobu";

		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Approval Transition",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
		});

		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET openapi_config = ${sql.json({
				specUrl: "https://api.example.test/openapi.json",
				serverUrl: "https://api.example.test",
			})}
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR}
		`;

		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { create_item: "approval" } },
		});
		connectionId = conn.id;

		const accountId = `acct_${connectionId}_transition`;
		await sql`
			INSERT INTO "account" (
			  id, "accountId", "providerId", "userId",
			  "accessToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"
			) VALUES (
			  ${accountId}, ${accountId}, 'test', ${userId},
			  'tok', ${new Date(Date.now() + 3_600_000).toISOString()}, 'read write', NOW(), NOW()
			)
		`;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: CONNECTOR,
			displayName: "transition test OAuth",
			profileKind: "oauth_account",
			provider: "test",
			accountId,
			status: "active",
			createdBy: userId,
		});
		await sql`
			UPDATE connections
			SET auth_profile_id = ${profile.id}
			WHERE id = ${connectionId}
		`;

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (input: string | URL | Request, init?: RequestInit) => {
					const url = String(input);
					if (url === "https://api.example.test/openapi.json") {
						return new Response(
							JSON.stringify({
								openapi: "3.0.0",
								servers: [{ url: "https://api.example.test" }],
								paths: {
									"/items": {
										post: {
											operationId: "create_item",
											requestBody: {
												content: {
													"application/json": {
														schema: { type: "object" },
													},
												},
											},
											responses: { "200": { description: "ok" } },
										},
									},
								},
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					}
					if (url === "https://api.example.test/items") {
						return new Response(JSON.stringify({ created: true }), {
							status: 200,
							headers: { "content-type": "application/json" },
						});
					}
					throw new Error(`Unexpected fetch: ${url}`);
				},
			),
		);
	});

	afterEach(async () => {
		// Always drop the failure triggers so they can't leak into other tests
		// that share this DB under the suite's single-fork registry.
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_PENDING_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
	});

	afterAll(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_PENDING_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
		vi.unstubAllGlobals();
	});

	it("terminal event write failure rolls back the run's completed state", async () => {
		const sql = getTestDb();
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "create_item",
				input: { body: { value: "transition-test" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number; status: string; event_id: number };
		expect(queued.status).toBe("pending_approval");

		// Before the approve, the card is pending (the queue path is already atomic).
		const before = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${queued.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(before[0]?.interaction_status).toBe("pending");

		// Force ONLY the terminal 'completed' card INSERT to fail; the 'confirmed'
		// event must still write so the failure is isolated to the terminal phase.
		await sql.unsafe(FAIL_COMPLETED_TRIGGER);

		await expect(
			manageOperations(
				{ action: "approve", run_id: queued.run_id },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/terminal approval-event write failure/);

		// RED today: the `runs.status='completed'` write commits before the card
		// INSERT throws, so the run is left terminal-completed while the card is
		// stuck at 'confirmed'. GREEN after the fix: both writes share one
		// transaction, so the terminal state rolls back and the run is NOT
		// completed (or failed) — it stays in the approved/running claim state.
		const [run] = await sql`
			SELECT approval_status, status, action_output
			FROM runs
			WHERE id = ${queued.run_id} AND organization_id = ${orgId}
		`;
		expect(run.status).not.toBe("completed");
		expect(run.status).not.toBe("failed");
		expect(run.approval_status).toBe("approved");

		// No completed card was ever written; the card stays at the confirmed
		// claim — consistent with a run that never reached terminal state.
		const [card] = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${queued.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(card?.interaction_status).toBe("approved");
	});

	it("builder completion card failure does NOT convert a successful apply into a business failure", async () => {
		const sql = getTestDb();
		const runId = await seedAgentAskRun(orgId, userId);

		// Force ONLY the terminal 'completed' card INSERT to fail; the 'confirmed'
		// claim must still succeed so the failure lands in phase 2 (after apply).
		await sql.unsafe(FAIL_COMPLETED_TRIGGER);

		// The apply (agent-ask returns the human's answer) SUCCEEDED — only the
		// terminal card persistence failed. The persistence error must propagate,
		// not be re-recorded as a business 'failed' via failBuilderRun.
		await expect(
			manageOperations(
				{ action: "approve", run_id: runId, input: { decision: "ship it" } },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/terminal approval-event write failure/);

		const [run] = await sql`
			SELECT approval_status, status, action_output
			FROM runs WHERE id = ${runId} AND organization_id = ${orgId}
		`;
		// The claim committed (approved/running) and phase 2 rolled back: the run
		// is NOT marked 'failed' (a false business failure) and NOT 'completed'.
		expect(run.status).not.toBe("failed");
		expect(run.status).not.toBe("completed");
		expect(run.status).toBe("running");
		expect(run.approval_status).toBe("approved");
		expect(run.action_output).toBeNull();

		// Card is still the 'confirmed' claim — no completed card, no failed card.
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"approved",
		);
	});

	it("queueAgentAsk run + pending card commit atomically (card failure leaves no run)", async () => {
		const sql = getTestDb();
		const runsBefore = await sql`
			SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId}
		`;
		const eventsBefore = await sql`
			SELECT count(*)::int AS n FROM events
			WHERE organization_id = ${orgId} AND interaction_type = 'approval'
		`;

		await sql.unsafe(FAIL_PENDING_TRIGGER);
		await expect(
			queueAgentAsk({
				ctx: humanCtx,
				question: "Queue-path atomicity check",
				body: null,
				inputSchema: { type: "object" },
			}),
		).rejects.toThrow(/pending approval-event write failure/);

		// The run INSERT shared the rolled-back transaction: no stranded pending
		// run and no orphaned card.
		const runsAfter = await sql`
			SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId}
		`;
		expect(runsAfter[0].n).toBe(runsBefore[0].n);
		const eventsAfter = await sql`
			SELECT count(*)::int AS n FROM events
			WHERE organization_id = ${orgId} AND interaction_type = 'approval'
		`;
		expect(eventsAfter[0].n).toBe(eventsBefore[0].n);
	});

	it("reject on a run with no approval card fails closed — the cancelled run write rolls back", async () => {
		const sql = getTestDb();
		// Corruption case: a pending connector-operation run whose approval card
		// was never written (bypasses the #2033 atomic queue). The reject must
		// NOT commit the cancelled write without a card.
		const [run] = await sql`
			INSERT INTO runs (
				organization_id, run_type, status, approval_status, action_key, created_at
			) VALUES (
				${orgId}, 'action', 'pending', 'pending', 'create_issue', NOW()
			)
			RETURNING id
		`;
		const runId = Number(run.id);

		await expect(
			manageOperations(
				{ action: "reject", run_id: runId, reason: "no card" },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/approval card is missing/);

		// The cancelled write shared the rolled-back transaction (the guard runs
		// INSIDE it): the run is still pending/pending, not cancelled.
		const [row] = await sql`
			SELECT approval_status, status FROM runs WHERE id = ${runId}
		`;
		expect(row.approval_status).toBe("pending");
		expect(row.status).toBe("pending");
	});
});

describe("worker completeActionRun card atomicity", () => {
	let orgId: string;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "complete action atomicity" });
		orgId = org.id;
		const [conn] = (await getTestDb()`
			INSERT INTO connections (
				organization_id, connector_key, status, visibility, slug,
				created_at, updated_at
			) VALUES (
				${orgId}, 'chrome', 'active', 'org', 'complete-action-test', NOW(), NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		connectionId = Number(conn.id);
	});

	afterEach(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
	});

	afterAll(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
	});

	async function seedClaimedRun(opts: {
		approvalStatus: string;
		withCard: boolean;
	}): Promise<number> {
		const sql = getTestDb();
		const [run] = (await sql`
			INSERT INTO runs (
				organization_id, run_type, connection_id, connector_key,
				connector_version, action_key, approval_status, status,
				claimed_by, claimed_at, created_at
			) VALUES (
				${orgId}, 'action', ${connectionId}, 'chrome',
				'0.2.0', 'navigate', ${opts.approvalStatus}, 'running',
				'worker-complete-test', NOW(), NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const runId = Number(run.id);
		if (opts.withCard) {
			await insertEvent({
				entityIds: [],
				organizationId: orgId,
				originId: `run_${runId}_confirmed`,
				title: "navigate — executing",
				content: null,
				semanticType: "operation",
				connectorKey: "chrome",
				runId,
				interactionType: "approval",
				interactionStatus: "approved",
				interactionInputSchema: null,
				metadata: {
					action_key: "navigate",
					status: "confirmed",
					run_id: runId,
				},
				authorName: "agent",
			});
		}
		return runId;
	}

	it("auto/no-approval run finalizes normally with no card (worker action preserved)", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "auto",
			withCard: false,
		});
		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "success",
			action_output: { ok: true },
		});
		await completeActionRun(ctx);
		expect((result().body as { success?: boolean }).success).toBe(true);

		const [run] = await getTestDb()`
			SELECT status, action_output FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("completed");
		expect(run.action_output).toEqual({ ok: true });
	});

	it("approval run terminal card write failure rolls the terminal state back", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: true,
		});
		await getTestDb().unsafe(FAIL_COMPLETED_TRIGGER);

		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "success",
			action_output: { ok: true },
		});
		await completeActionRun(ctx);
		expect((result().body as { error?: string }).error).toMatch(
			/terminal approval-event write failure/,
		);
		expect(result().status).toBe(500);

		// The finalizeRun write shared the rolled-back transaction: the run is
		// still running (not completed) and the card is untouched.
		const [run] = await getTestDb()`
			SELECT status FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("running");
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"approved",
		);
	});

	it("approval run with a missing card fails closed (terminal state rolled back)", async () => {
		// Corruption case: approval-gated run whose card was never written or was
		// lost. The completion must NOT commit the terminal state without a card.
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: false,
		});
		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "success",
			action_output: { ok: true },
		});
		await completeActionRun(ctx);
		expect((result().body as { error?: string }).error).toMatch(
			/approval card is missing/,
		);
		expect(result().status).toBe(500);

		const [run] = await getTestDb()`
			SELECT status FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("running");
	});

	it("worker pre-dispatch failure supersedes the approved card atomically", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: true,
		});

		const changed = await failClaimedWorkerRun({
			runId,
			workerId: "worker-complete-test",
			errorMessage: "connector code unavailable",
		});

		expect(changed).toBe(true);
		const [run] = await getTestDb()`
			SELECT status, error_message FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("failed");
		expect(run.error_message).toBe("connector code unavailable");
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"failed",
		);
	});

	it("worker pre-dispatch failure rolls back when the failed card write fails", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: true,
		});
		await getTestDb().unsafe(FAIL_FAILED_TRIGGER);

		await expect(
			failClaimedWorkerRun({
				runId,
				workerId: "worker-complete-test",
				errorMessage: "connector code unavailable",
			}),
		).rejects.toThrow(/failed approval-event write failure/);

		const [run] = await getTestDb()`
			SELECT status, error_message FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("running");
		expect(run.error_message).toBeNull();
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"approved",
		);
	});
});
