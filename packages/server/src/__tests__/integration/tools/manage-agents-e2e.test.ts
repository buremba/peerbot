/**
 * manage_agents — end-to-end coverage over the real tool path
 * (`executeTool(name, args, env, authCtx)`), the same entry the REST proxy and
 * the builder agent's worker use.
 *
 * WRITE actions (create/update/delete) route through the `agent_config`
 * write-gate class. The decision is per-principal:
 *   - A HUMAN member applies immediately — no run, no approval card. Role
 *     restrictions for humans live in the tool-access tier (admin-only).
 *   - An AGENT-driven write follows the org policy (default: create/update queue
 *     a pending `runs` row + approval card, applied on approve / cancelled on
 *     reject; delete is denied). This is the durable runs/events primitive that
 *     manage_operations uses.
 *
 * Covers:
 *   - human owner: create/update/delete apply immediately.
 *   - agent principal create gate: pending run + pending approval event, NO agent yet.
 *   - approve(run_id): agent now exists (owner_platform='external' + the
 *     agent_users ownership mapping), run completed, event superseded.
 *   - reject(run_id): no agent, run cancelled, event superseded 'rejected'.
 *   - agent update gate applies on approve; agent delete is denied outright.
 *   - stale approval: applyUpdate skips a field a newer edit already changed.
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
	let agentCtx: AuthContext;
	let memberCtx: AuthContext;

	const baseCtx = (
		orgIdValue: string,
		userId: string,
		memberRole: "owner" | "member",
		scopes: string[],
		agentId: string | null = null,
	): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole,
		agentId,
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
		// Same owner identity, but acting as an agent (agentId set) — this is the
		// principal the write-gate holds for approval.
		agentCtx = baseCtx(
			org.id,
			owner.id,
			"owner",
			["mcp:read", "mcp:write", "mcp:admin"],
			"builder-agent",
		);
		memberCtx = baseCtx(org.id, member.id, "member", ["mcp:read", "mcp:write"]);
	});

	it("human owner: create applies immediately with no approval run", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "human-bot", name: "Human Bot" },
			TEST_ENV,
			ownerCtx,
		)) as { action: string; created?: boolean; status?: string };
		expect(res.status).toBeUndefined();
		expect(res.created).toBe(true);
		expect(await agentExists(orgId, "human-bot")).toBe(true);

		// No pending manage_agents run was created for this immediate apply.
		const sql = getTestDb();
		const runRows = await sql`
			SELECT 1 FROM runs
			WHERE organization_id = ${orgId} AND action_key = 'manage_agents'
				AND (action_input->>'agent_id') = 'human-bot'
		`;
		expect(runRows.length).toBe(0);
	});

	it("human owner: update and delete apply immediately", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "human-edit-bot", name: "v1" },
			TEST_ENV,
			ownerCtx,
		);
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "human-edit-bot", name: "v2" },
			TEST_ENV,
			ownerCtx,
		)) as { action: string; updated_fields?: string[]; status?: string };
		expect(upd.status).toBeUndefined();
		expect(upd.updated_fields).toContain("name");
		const sql = getTestDb();
		const nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'human-edit-bot'
		`;
		expect(nameRows[0]?.name).toBe("v2");

		const del = (await executeTool(
			"manage_agents",
			{ action: "delete", agent_id: "human-edit-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { action: string; deleted?: boolean; status?: string };
		expect(del.status).toBeUndefined();
		expect(del.deleted).toBe(true);
		expect(await agentExists(orgId, "human-edit-bot")).toBe(false);
	});

	it("agent create produces a pending run + approval event and does NOT create the agent yet", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "support-bot", name: "Support Bot" },
			TEST_ENV,
			agentCtx,
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
			agentCtx,
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

	it("agent update gate applies field changes on approve", async () => {
		// Land a base agent immediately as the human owner.
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "editable-bot", name: "Editable Bot" },
			TEST_ENV,
			ownerCtx,
		);

		// An agent-driven update is gated.
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "editable-bot", name: "Editable Bot v2" },
			TEST_ENV,
			agentCtx,
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

	it("a stale approval skips a field another writer already changed", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "raced-bot", name: "Original" },
			TEST_ENV,
			ownerCtx,
		);
		// Agent proposes name → "Agent Name" (pre-image captured: "Original").
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "raced-bot", name: "Agent Name" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(upd.status).toBe("pending_approval");

		// Meanwhile a human renames it — pre-image no longer matches.
		await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "raced-bot", name: "Human Name" },
			TEST_ENV,
			ownerCtx,
		);

		// Approving the stale proposal must NOT clobber the human's newer name.
		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: upd.run_id },
			TEST_ENV,
			ownerCtx,
		);
		const sql = getTestDb();
		const nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'raced-bot'
		`;
		expect(nameRows[0]?.name).toBe("Human Name");
	});

	it("a legacy pending run with no pre-image fails closed (does NOT clobber)", async () => {
		// Simulates a run queued BEFORE the base-capture branch shipped: its
		// action_input has no `base`. Approving it must skip the field (fail closed),
		// never blind-overwrite a newer human edit (sol review #8).
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "legacy-bot", name: "Original" },
			TEST_ENV,
			ownerCtx,
		);
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "legacy-bot", name: "Agent Name" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;

		const sql = getTestDb();
		// Strip `base` from the queued proposal to mimic a pre-branch legacy run.
		await sql`
			UPDATE runs
			SET action_input = (action_input - 'base')
			WHERE id = ${upd.run_id} AND organization_id = ${orgId}
		`;

		// A human renames it after the (now base-less) proposal was queued.
		await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "legacy-bot", name: "Human Name" },
			TEST_ENV,
			ownerCtx,
		);

		// Approving the legacy proposal must NOT overwrite the human's newer name.
		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: upd.run_id },
			TEST_ENV,
			ownerCtx,
		);
		const nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'legacy-bot'
		`;
		expect(nameRows[0]?.name).toBe("Human Name");
	});

	it("agent delete is denied outright (a human must delete an agent)", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "protected-bot", name: "Protected Bot" },
			TEST_ENV,
			ownerCtx,
		);
		expect(await agentExists(orgId, "protected-bot")).toBe(true);

		await expect(
			executeTool(
				"manage_agents",
				{ action: "delete", agent_id: "protected-bot" },
				TEST_ENV,
				agentCtx,
			),
		).rejects.toThrow();
		// The agent survives the denied delete.
		expect(await agentExists(orgId, "protected-bot")).toBe(true);
	});

	it("get / set_system_agent / list stay immediate", async () => {
		// Land an agent immediately as the human owner.
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "system-bot", name: "System Bot" },
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
