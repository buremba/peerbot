import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

describe("manage_automations delivery_target", () => {
	let ownerCtx: AuthContext;
	let organizationId: string;
	let agentId: string;
	let otherAgentId: string;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "Automation delivery target" });
		organizationId = org.id;
		const owner = await createTestUser({ email: "delivery-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${org.id}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "delivery-agent",
			ownerUserId: owner.id,
		});
		agentId = agent.agentId;
		const otherAgent = await createTestAgent({
			organizationId: org.id,
			agentId: "other-delivery-agent",
			ownerUserId: owner.id,
		});
		otherAgentId = otherAgent.agentId;
		await insertChatConnectionRow({
			id: "slackinst-delivery",
			organizationId: org.id,
			agentId: null,
			platform: "slack",
			metadata: { teamId: "T_DELIVERY" },
		});
		const sql = getTestDb();
		const [connection] = await sql<{ id: number }>`
			SELECT id FROM connections
			WHERE organization_id = ${org.id}
			  AND slug = 'slackinst-delivery'
		`;
		connectionId = Number(connection.id);
		await createTestAutomationSubscription({
			organizationId: org.id,
			agentId,
			connectionId,
			platform: "slack",
			// Legacy bindings may store the native channel id without a platform
			// prefix. The public target still uses the recommended canonical key.
			channelId: "C_TASKS",
			teamId: "T_DELIVERY",
			configuredBy: owner.id,
		});
	});

	it("persists, projects, validates, and clears a strict bound channel", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "delivery-targeted",
				name: "Delivery targeted",
				prompt: "Send a concise update.",
				managed_agent_id: agentId,
				delivery_target: {
					connection_id: connectionId,
					channel_id: "slack:C_TASKS",
				},
			},
			TEST_ENV,
			ownerCtx,
		)) as { automation_id: string };

		const sql = getTestDb();
		const [stored] = await sql<{ delivery_target: Record<string, unknown> }>`
			SELECT delivery_target FROM automations WHERE id = ${created.automation_id}
		`;
		expect(stored.delivery_target).toEqual({
			connection_id: connectionId,
			channel_id: "slack:C_TASKS",
		});

		const listed = (await executeTool(
			"manage_automations",
			{ action: "list", status: "active" },
			TEST_ENV,
			ownerCtx,
		)) as { automations: Array<Record<string, unknown>> };
		expect(
			listed.automations.find((row) => row.automation_id === created.automation_id),
		).toMatchObject({ delivery_target: stored.delivery_target });

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: created.automation_id,
					delivery_target: {
						connection_id: connectionId,
						channel_id: "slack:C_FINANCE",
					},
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/must be an active chat channel already bound to the same agent/);

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: created.automation_id,
					managed_agent_id: otherAgentId,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/must be an active chat channel already bound to the same agent/);
		const [afterRejectedMove] = await sql<{
			managed_agent_id: string;
			delivery_target: Record<string, unknown>;
		}>`
			SELECT managed_agent_id, delivery_target
			FROM automations
			WHERE id = ${created.automation_id}
		`;
		expect(afterRejectedMove).toMatchObject({
			managed_agent_id: agentId,
			delivery_target: stored.delivery_target,
		});

		const cleared = (await executeTool(
			"manage_automations",
			{
				action: "update",
				automation_id: created.automation_id,
				delivery_target: null,
			},
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields: string[] };
		expect(cleared.updated_fields).toContain("delivery_target");
		const [afterClear] = await sql<{ delivery_target: unknown }>`
			SELECT delivery_target FROM automations WHERE id = ${created.automation_id}
		`;
		expect(afterClear.delivery_target).toBeNull();
	});
});
