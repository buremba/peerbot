/**
 * manage_agents — end-to-end coverage over the real tool path
 * (`executeTool(name, args, env, authCtx)`), the same entry the REST proxy and
 * the builder agent's worker use.
 *
 * Covers the behaviors the builder feature added/relies on:
 *   - create: inserts the agents row (owner_platform='external') AND the
 *     agent_users ownership mapping, so the per-user chat path can reach it.
 *   - get / update / list (including the `is_system_agent` flag).
 *   - set_system_agent: points organization.system_agent_id at an agent.
 *   - delete: refuses the org's system agent; succeeds once it's repointed.
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

describe("manage_agents — tool e2e", () => {
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
		allowInternalTools: true,
	});

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();

		const org = await createTestOrganization({ name: "manage_agents e2e" });
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

	it("create inserts the agents row AND the agent_users ownership mapping", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "support-bot", name: "Support Bot" },
			TEST_ENV,
			ownerCtx,
		)) as { created: boolean };
		expect(res.created).toBe(true);

		const sql = getTestDb();
		const agentRows = await sql`
			SELECT owner_platform, owner_user_id FROM agents
			WHERE organization_id = ${orgId} AND id = 'support-bot'
		`;
		expect(agentRows[0]?.owner_platform).toBe("external");
		expect(agentRows[0]?.owner_user_id).toBe(ownerId);

		const userRows = await sql`
			SELECT 1 FROM agent_users
			WHERE organization_id = ${orgId} AND agent_id = 'support-bot'
				AND platform = 'external' AND user_id = ${ownerId}
		`;
		expect(userRows.length).toBe(1);
	});

	it("get returns the created agent; update changes fields", async () => {
		const got = (await executeTool(
			"manage_agents",
			{ action: "get", agent_id: "support-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { agent?: { id: string; name: string } };
		expect(got.agent?.id).toBe("support-bot");

		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "support-bot", name: "Support Bot v2" },
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields: string[] };
		expect(upd.updated_fields).toContain("name");
	});

	it("set_system_agent flips the org pointer + the list flag", async () => {
		await executeTool(
			"manage_agents",
			{ action: "set_system_agent", agent_id: "support-bot" },
			TEST_ENV,
			ownerCtx,
		);
		const list = (await executeTool(
			"manage_agents",
			{ action: "list" },
			TEST_ENV,
			ownerCtx,
		)) as { agents: Array<{ id: string; is_system_agent: boolean }> };
		const row = list.agents.find((a) => a.id === "support-bot");
		expect(row?.is_system_agent).toBe(true);
	});

	it("delete refuses the system agent, then succeeds once repointed", async () => {
		await expect(
			executeTool(
				"manage_agents",
				{ action: "delete", agent_id: "support-bot" },
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow();

		// Repoint the org's system agent elsewhere, then the delete is allowed.
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "other-bot", name: "Other Bot" },
			TEST_ENV,
			ownerCtx,
		);
		await executeTool(
			"manage_agents",
			{ action: "set_system_agent", agent_id: "other-bot" },
			TEST_ENV,
			ownerCtx,
		);
		const del = (await executeTool(
			"manage_agents",
			{ action: "delete", agent_id: "support-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { deleted: boolean };
		expect(del.deleted).toBe(true);
	});

	it("a non-admin member cannot call admin-tier actions", async () => {
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
