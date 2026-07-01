/**
 * manage_agents — end-to-end coverage over the real tool path
 * (`executeTool(name, args, env, authCtx)`), the same entry the REST proxy and
 * the builder agent's worker use.
 *
 * The builder gate (this feature) routes WRITE actions (create/update/delete)
 * through the durable runs/events approval primitive that manage_operations
 * uses: a write produces a pending `runs` row (approval_status='pending') + an
 * approval `events` card; the mutation only lands when a web session approves
 * via manage_operations.approve, and is cancelled on reject. Read actions
 * (list/get) and set_system_agent stay immediate.
 *
 * Covers:
 *   - create gate: pending run + pending approval event, NO agent yet.
 *   - approve(run_id): agent now exists (owner_platform='external' + the
 *     agent_users ownership mapping), run completed, event superseded.
 *   - reject(run_id): no agent, run cancelled, event superseded 'rejected'.
 *   - update / delete gates apply on approve.
 *   - set_system_agent / get / list (including the `is_system_agent` flag) stay
 *     immediate.
 *   - access: a non-admin member cannot call the admin-tier actions.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
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
};

async function agentExists(orgId: string, agentId: string): Promise<boolean> {
	const sql = getTestDb();
	const rows = await sql`
		SELECT 1 FROM agents WHERE organization_id = ${orgId} AND id = ${agentId}
	`;
	return rows.length > 0;
}

describe("manage_agents — builder gate e2e", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let memberCtx: AuthContext;

	const baseCtx = (
		orgIdValue: string,
		userId: string,
		memberRole: "owner" | "member",
		scopes: string[],
	): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole,
		agentId: null,
		requestedAgentId: null,
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

		const org = await createTestOrganization({ name: "manage_agents gate e2e" });
		orgId = org.id;
		const owner = await createTestUser({ email: "ma-owner@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");
		const member = await createTestUser({ email: "ma-member@test.com" });
		await addUserToOrganization(member.id, org.id, "member");

		ownerCtx = baseCtx(org.id, owner.id, "owner", [
			"mcp:read",
			"mcp:write",
			"mcp:admin",
		]);
		memberCtx = baseCtx(org.id, member.id, "member", ["mcp:read", "mcp:write"]);
	});

	it("create produces a pending run + approval event and does NOT create the agent yet", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "support-bot", name: "Support Bot" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;

		expect(res.status).toBe("pending_approval");
		expect(typeof res.run_id).toBe("number");

		const sql = getTestDb();

		// Pending run, run_type='internal', held proposal in action_input.
		const runRows = await sql`
			SELECT run_type, action_key, approval_status, status, action_input, created_by_user_id
			FROM runs WHERE id = ${res.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows.length).toBe(1);
		expect(runRows[0]?.run_type).toBe("internal");
		expect(runRows[0]?.action_key).toBe("manage_agents");
		expect(runRows[0]?.approval_status).toBe("pending");
		expect(runRows[0]?.status).toBe("pending");
		expect(runRows[0]?.created_by_user_id).toBe(ownerId);
		const proposal = runRows[0]?.action_input as {
			action: string;
			agent_id: string;
			name?: string;
		};
		expect(proposal.action).toBe("create");
		expect(proposal.agent_id).toBe("support-bot");
		expect(proposal.name).toBe("Support Bot");

		// Pending approval event exists for this run.
		const eventRows = await sql`
			SELECT interaction_type, interaction_status, metadata
			FROM current_event_records
			WHERE run_id = ${res.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows.length).toBe(1);
		expect(eventRows[0]?.interaction_status).toBe("pending");

		// No agent created yet — the gate is the whole point.
		expect(await agentExists(orgId, "support-bot")).toBe(false);
	});

	it("approve applies the held create: agent + ownership mapping exist, run completed, event superseded", async () => {
		const created = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "approved-bot", name: "Approved Bot" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");
		expect(await agentExists(orgId, "approved-bot")).toBe(false);

		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			ownerCtx,
		)) as { approved?: true };
		expect(approveRes.approved).toBe(true);

		const sql = getTestDb();

		// Agent now exists with owner attribution + agent_users mapping.
		const agentRows = await sql`
			SELECT owner_platform, owner_user_id FROM agents
			WHERE organization_id = ${orgId} AND id = 'approved-bot'
		`;
		expect(agentRows.length).toBe(1);
		expect(agentRows[0]?.owner_platform).toBe("external");
		expect(agentRows[0]?.owner_user_id).toBe(ownerId);

		const userRows = await sql`
			SELECT 1 FROM agent_users
			WHERE organization_id = ${orgId} AND agent_id = 'approved-bot'
				AND platform = 'external' AND user_id = ${ownerId}
		`;
		expect(userRows.length).toBe(1);

		// Run completed + approved.
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

	it("reject cancels the held create: no agent, run cancelled, event superseded 'rejected'", async () => {
		const created = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "rejected-bot", name: "Rejected Bot" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");

		const rejectRes = (await executeTool(
			"manage_operations",
			{ action: "reject", run_id: created.run_id, reason: "not now" },
			TEST_ENV,
			ownerCtx,
		)) as { rejected?: true };
		expect(rejectRes.rejected).toBe(true);

		// No agent created.
		expect(await agentExists(orgId, "rejected-bot")).toBe(false);

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

	it("update gate applies field changes on approve", async () => {
		// Land a base agent first (create → approve).
		const created = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "editable-bot", name: "Editable Bot" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;
		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			ownerCtx,
		);

		// Now gate an update.
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "editable-bot", name: "Editable Bot v2" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;
		expect(upd.status).toBe("pending_approval");

		const sql = getTestDb();
		// Name not changed until approval.
		let nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'editable-bot'
		`;
		expect(nameRows[0]?.name).toBe("Editable Bot");

		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: upd.run_id },
			TEST_ENV,
			ownerCtx,
		);
		nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'editable-bot'
		`;
		expect(nameRows[0]?.name).toBe("Editable Bot v2");
	});

	it("delete gate removes the agent on approve", async () => {
		const created = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "doomed-bot", name: "Doomed Bot" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;
		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			ownerCtx,
		);
		expect(await agentExists(orgId, "doomed-bot")).toBe(true);

		const del = (await executeTool(
			"manage_agents",
			{ action: "delete", agent_id: "doomed-bot" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;
		expect(del.status).toBe("pending_approval");
		// Still present until approval.
		expect(await agentExists(orgId, "doomed-bot")).toBe(true);

		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: del.run_id },
			TEST_ENV,
			ownerCtx,
		);
		expect(await agentExists(orgId, "doomed-bot")).toBe(false);
	});

	it("get / set_system_agent / list stay immediate", async () => {
		// Land an agent through the gate.
		const created = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "system-bot", name: "System Bot" },
			TEST_ENV,
			ownerCtx,
		)) as PendingApproval;
		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			ownerCtx,
		);

		const got = (await executeTool(
			"manage_agents",
			{ action: "get", agent_id: "system-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { agent?: { id: string } };
		expect(got.agent?.id).toBe("system-bot");

		// set_system_agent is immediate (no approval gate).
		const setRes = (await executeTool(
			"manage_agents",
			{ action: "set_system_agent", agent_id: "system-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { system_agent_id?: string };
		expect(setRes.system_agent_id).toBe("system-bot");

		const list = (await executeTool(
			"manage_agents",
			{ action: "list" },
			TEST_ENV,
			ownerCtx,
		)) as { agents: Array<{ id: string; is_system_agent: boolean }> };
		const row = list.agents.find((a) => a.id === "system-bot");
		expect(row?.is_system_agent).toBe(true);
	});

	it("a non-admin member cannot call admin-tier write actions", async () => {
		await expect(
			executeTool(
				"manage_agents",
				{ action: "create", agent_id: "member-bot", name: "Member Bot" },
				TEST_ENV,
				memberCtx,
			),
		).rejects.toThrow();
	});
});
