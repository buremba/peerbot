/**
 * manage_watchers — builder-gate approval queue (agent_config write class).
 *
 * WRITE definition actions (create/update/delete/create_version/…) route through
 * the same `agent_config` write-gate class as manage_agents:
 *   - A HUMAN member applies immediately — no run, no approval card.
 *   - An AGENT-driven write follows the org policy (default: create/update queue
 *     a pending `runs` row + approval event; delete is denied). Approving via
 *     manage_operations applies the held mutation and supersedes the pending card.
 *
 * Covers:
 *   - agent create → pending_approval (NOT 403), no watcher row yet
 *   - approve → watcher exists, run completed, event superseded 'completed'
 *   - reject → no watcher, run cancelled, event superseded 'rejected'
 *   - human create still applies immediately
 *   - foreign-owner escalation still 403s before queueing
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
	addUserToOrganization,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

type PendingApproval = {
	status: "pending_approval";
	run_id: number;
	event_id?: number;
	action: string;
	proposal?: { args?: { action?: string; slug?: string } };
};

async function watcherExists(orgId: string, slug: string): Promise<boolean> {
	const sql = getTestDb();
	const rows = await sql`
		SELECT 1 FROM watchers WHERE organization_id = ${orgId} AND slug = ${slug}
	`;
	return rows.length > 0;
}

describe("manage_watchers — builder gate e2e", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let agentCtx: AuthContext;
	let agentId: string;
	let otherAgentId: string;

	const baseCtx = (
		orgIdValue: string,
		userId: string,
		memberRole: "owner" | "member",
		scopes: string[],
		boundAgentId: string | null = null,
	): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole,
		agentId: boundAgentId,
		requestedAgentId: boundAgentId,
		isAuthenticated: true,
		clientId: null,
		scopes,
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgIdValue}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	});

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();

		const org = await createTestOrganization({
			name: "manage_watchers gate e2e",
		});
		orgId = org.id;
		const owner = await createTestUser({ email: "mw-owner@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");

		ownerCtx = baseCtx(org.id, owner.id, "owner", [
			"mcp:read",
			"mcp:write",
			"mcp:admin",
		]);

		const builder = await createTestAgent({
			organizationId: org.id,
			agentId: "builder-agent",
			ownerUserId: owner.id,
		});
		agentId = builder.agentId;
		const other = await createTestAgent({
			organizationId: org.id,
			ownerUserId: owner.id,
		});
		otherAgentId = other.agentId;

		// Same owner identity, but acting as the builder agent — principal the
		// agent_config write-gate holds for approval.
		agentCtx = baseCtx(
			org.id,
			owner.id,
			"owner",
			["mcp:read", "mcp:write", "mcp:admin"],
			agentId,
		);
	});

	it("human owner: create applies immediately with no approval run", async () => {
		const res = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "human-watcher",
				name: "Human Watcher",
				prompt: "Track things.",
				agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx,
		)) as { action: string; watcher_id?: string; status?: string };
		// Immediate apply returns the watcher status ('active'), not pending_approval.
		expect(res.status).not.toBe("pending_approval");
		expect(res.watcher_id).toBeDefined();
		expect(await watcherExists(orgId, "human-watcher")).toBe(true);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT 1 FROM runs
			WHERE organization_id = ${orgId} AND action_key = 'manage_watchers'
				AND approval_status = 'pending'
		`;
		expect(runRows.length).toBe(0);
	});

	it("agent create produces a pending run + approval event and does NOT create the watcher yet", async () => {
		const res = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "agent-proposed-watcher",
				name: "Agent Proposed",
				prompt: "Track launches.",
				agent_id: agentId,
			},
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;

		expect(res.status).toBe("pending_approval");
		expect(typeof res.run_id).toBe("number");
		expect(res.action).toBe("create");
		expect(res.proposal?.args?.slug).toBe("agent-proposed-watcher");

		const sql = getTestDb();
		const runRows = await sql`
			SELECT run_type, action_key, approval_status, status, action_input, created_by_user_id
			FROM runs WHERE id = ${res.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows.length).toBe(1);
		expect(runRows[0]?.run_type).toBe("internal");
		expect(runRows[0]?.action_key).toBe("manage_watchers");
		expect(runRows[0]?.approval_status).toBe("pending");
		expect(runRows[0]?.status).toBe("pending");
		expect(runRows[0]?.created_by_user_id).toBe(ownerId);

		const eventRows = await sql`
			SELECT interaction_type, interaction_status
			FROM current_event_records
			WHERE run_id = ${res.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows.length).toBe(1);
		expect(eventRows[0]?.interaction_status).toBe("pending");

		expect(await watcherExists(orgId, "agent-proposed-watcher")).toBe(false);
	});

	it("approve applies the held create: watcher exists, run completed, event superseded", async () => {
		const created = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "approved-watcher",
				name: "Approved Watcher",
				prompt: "Track approved items.",
				agent_id: agentId,
			},
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");
		expect(await watcherExists(orgId, "approved-watcher")).toBe(false);

		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			ownerCtx,
		)) as { approved?: true };
		expect(approveRes.approved).toBe(true);

		expect(await watcherExists(orgId, "approved-watcher")).toBe(true);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT approval_status, status FROM runs
			WHERE id = ${created.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.approval_status).toBe("approved");
		expect(runRows[0]?.status).toBe("completed");

		// Current event for the run is now 'completed' (the pending card was superseded).
		const eventRows = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${created.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows[0]?.interaction_status).toBe("completed");
	});

	it("reject cancels the held create: no watcher, run cancelled, event superseded 'rejected'", async () => {
		const created = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "rejected-watcher",
				name: "Rejected Watcher",
				prompt: "Track rejected items.",
				agent_id: agentId,
			},
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");

		const rejectRes = (await executeTool(
			"manage_operations",
			{ action: "reject", run_id: created.run_id, reason: "not now" },
			TEST_ENV,
			ownerCtx,
		)) as { rejected?: true };
		expect(rejectRes.rejected).toBe(true);

		expect(await watcherExists(orgId, "rejected-watcher")).toBe(false);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT approval_status, status FROM runs
			WHERE id = ${created.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.approval_status).toBe("rejected");
		expect(runRows[0]?.status).toBe("cancelled");

		const eventRows = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${created.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows[0]?.interaction_status).toBe("rejected");
	});

	it("foreign-owner create still 403s and does not queue a pending run", async () => {
		await expect(
			executeTool(
				"manage_watchers",
				{
					action: "create",
					slug: "foreign-owned",
					name: "Foreign Owned",
					prompt: "Should not queue.",
					agent_id: otherAgentId,
				},
				TEST_ENV,
				agentCtx,
			),
		).rejects.toThrow(/cannot install watcher behavior owned by another agent/i);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT 1 FROM runs
			WHERE organization_id = ${orgId} AND action_key = 'manage_watchers'
				AND approval_status = 'pending'
				AND action_input::text LIKE '%foreign-owned%'
		`;
		expect(runRows.length).toBe(0);
	});

	it("approve of update with invalid timezone marks run failed (not completed)", async () => {
		// Seed a watcher via the human path so there is a target to update.
		const created = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "tz-fail-watcher",
				name: "TZ Fail Watcher",
				prompt: "Track timezone failures.",
				agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx,
		)) as { watcher_id?: string; status?: string };
		expect(created.watcher_id).toBeDefined();
		const watcherId = created.watcher_id!;

		// Agent proposes an update with a bad timezone — queues for approval.
		// handleUpdate returns `{ error }` (does not throw); the apply boundary
		// must treat that as failure so we never mark the run completed.
		const pending = (await executeTool(
			"manage_watchers",
			{
				action: "update",
				watcher_id: watcherId,
				timezone: "Not/A_Real_Zone",
			},
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(pending.status).toBe("pending_approval");
		expect(typeof pending.run_id).toBe("number");

		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: pending.run_id },
			TEST_ENV,
			ownerCtx,
		)) as { approved?: true; message?: string };
		expect(approveRes.approved).toBe(true);
		expect(approveRes.message).toMatch(/failed/i);
		expect(approveRes.message).not.toMatch(/applied/i);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT approval_status, status, error_message FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.approval_status).toBe("approved");
		expect(runRows[0]?.status).toBe("failed");
		expect(String(runRows[0]?.error_message ?? "")).toMatch(/timezone|IANA/i);

		const eventRows = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${pending.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows[0]?.interaction_status).toBe("failed");
	});

	it("rejects a no-op update (only watcher_id, no patch fields)", async () => {
		const created = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "noop-update-target",
				name: "Noop target",
				prompt: "Target.",
				agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx,
		)) as { watcher_id?: string };
		const watcherId = created.watcher_id!;
		await expect(
			executeTool(
				"manage_watchers",
				{ action: "update", watcher_id: watcherId },
				TEST_ENV,
				agentCtx,
			),
		).rejects.toThrow(/at least one field to change/i);
	});

	it("rejects set_reaction_script with no reaction_script (would silently clear)", async () => {
		const created = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "reaction-target",
				name: "Reaction target",
				prompt: "Target.",
				agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx,
		)) as { watcher_id?: string };
		const watcherId = created.watcher_id!;
		await expect(
			executeTool(
				"manage_watchers",
				{ action: "set_reaction_script", watcher_id: watcherId },
				TEST_ENV,
				agentCtx,
			),
		).rejects.toThrow(/reaction_script is required/i);
	});

	it("stale cross-owner approval is rejected on apply after the watcher is reassigned", async () => {
		// Agent A creates a watcher it owns (queue + approve so A is the owner).
		const created = (await executeTool(
			"manage_watchers",
			{
				action: "create",
				slug: "a-owned-then-reassigned",
				name: "A owned",
				prompt: "Owned by agent A at queue time.",
				agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx,
		)) as { watcher_id?: string };
		const watcherId = created.watcher_id!;
		expect(watcherId).toBeDefined();

		// Agent A queues an update. The proposal captures A as the acting agent.
		const pending = (await executeTool(
			"manage_watchers",
			{
				action: "update",
				watcher_id: watcherId,
				schedule: "0 9 * * *",
			},
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(pending.status).toBe("pending_approval");

		// Race: the watcher is reassigned to agent B while the approval is pending.
		const sql = getTestDb();
		await sql`
			UPDATE watchers SET agent_id = ${otherAgentId}
			WHERE id = ${watcherId} AND organization_id = ${orgId}
		`;

		// Approving must NOT apply A's held mutation to B-owned behavior: the
		// apply path re-checks ownership against the persisted acting agent under
		// the group lock and fails closed.
		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: pending.run_id },
			TEST_ENV,
			ownerCtx,
		)) as { approved?: true; message?: string };
		expect(approveRes.message).toMatch(/failed/i);
		expect(approveRes.message).not.toMatch(/applied/i);

		// The held edit was NOT applied.
		const watcherRows = await sql`
			SELECT schedule FROM watchers
			WHERE id = ${watcherId} AND organization_id = ${orgId}
		`;
		expect(watcherRows[0]?.schedule).not.toBe("0 9 * * *");

		// Run marked failed; card superseded to failed.
		const runRows = await sql`
			SELECT status FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.status).toBe("failed");
	});
});
