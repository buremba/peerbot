/**
 * Foreign-key-shaped reference validation on manage_behaviors.
 *
 * `agent_id` and `keying_config.entity_type` are both free-text columns with NO
 * database foreign key, so a typo is accepted and only fails much later — or
 * never fails at all, silently:
 *
 *  - `agent_id`: the scheduler joins behaviors to agents on `agent_id`, so a
 *    nonexistent agent yields a Behavior that reports status 'active' /
 *    health 'healthy' and never runs. `behaviors.create` documents
 *    `throws: ["EntityNotFound"]` for exactly this case (see
 *    src/sandbox/method-metadata.ts) but never resolved the id.
 *  - `keying_config.entity_type`: deriveBehaviorExtractionSchema() returns null
 *    for an unknown type, and complete_window SKIPS extraction validation when
 *    the derived schema is null — so an unknown type silently VOIDS the output
 *    contract instead of enforcing it. Its sibling `entity_id` is validated
 *    and throws, so the pair was inconsistent.
 *
 * Both are validated on create, update, and create_version.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
};

function ownerCtx(orgId: string, userId: string): AuthContext {
	return {
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgId}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	};
}

describe("manage_behaviors reference validation", () => {
	let workspace: TestWorkspace;
	let ctx: AuthContext;
	let agentId: string;

	beforeEach(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create();
		ctx = ownerCtx(workspace.org.id, workspace.users.owner.id);
		const agent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		agentId = agent.agentId;
	});

	// ============================================
	// agent_id
	// ============================================

	it("create rejects a nonexistent agent_id (documented EntityNotFound)", async () => {
		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create",
					slug: "ghost-agent",
					name: "ghost-agent",
					prompt: "Track things.",
					agent_id: "agent-does-not-exist",
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Agent "agent-does-not-exist" not found/i);
	});

	it("create does NOT persist a Behavior when agent_id is nonexistent", async () => {
		await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ghost-agent-norow",
				name: "ghost-agent-norow",
				prompt: "Track things.",
				agent_id: "agent-does-not-exist",
			},
			TEST_ENV,
			ctx
		).catch(() => undefined);

		const rows = await getTestDb()<{ id: number }>`
      SELECT id FROM behaviors WHERE slug = ${"ghost-agent-norow"}
    `;
		expect(rows).toHaveLength(0);
	});

	it("create rejects an agent_id belonging to ANOTHER organization", async () => {
		const other = await TestWorkspace.create({ name: "Other Org" });
		const foreign = await createTestAgent({
			organizationId: other.org.id,
			ownerUserId: other.users.owner.id,
		});

		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create",
					slug: "cross-org-agent",
					name: "cross-org-agent",
					prompt: "Track things.",
					agent_id: foreign.agentId,
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/not found/i);
	});

	it("update rejects a nonexistent agent_id", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "update-agent-target",
				name: "update-agent-target",
				prompt: "Track things.",
				agent_id: agentId,
			},
			TEST_ENV,
			ctx
		)) as { behavior_id: string };

		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "update",
					behavior_id: created.behavior_id,
					agent_id: "agent-does-not-exist",
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Agent "agent-does-not-exist" not found/i);

		// The stored owner must be untouched by the rejected update.
		const [row] = await getTestDb()<{ agent_id: string }>`
      SELECT agent_id FROM behaviors WHERE id = ${Number(created.behavior_id)}
    `;
		expect(row.agent_id).toBe(agentId);
	});

	it("create/update accept a real agent_id", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "happy-agent",
				name: "happy-agent",
				prompt: "Track things.",
				agent_id: agentId,
			},
			TEST_ENV,
			ctx
		)) as { behavior_id: string };
		expect(created.behavior_id).toBeDefined();

		const second = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		const updated = (await executeTool(
			"manage_behaviors",
			{
				action: "update",
				behavior_id: created.behavior_id,
				agent_id: second.agentId,
			},
			TEST_ENV,
			ctx
		)) as { updated_fields: string[] };
		expect(updated.updated_fields).toContain("agent_id");
	});

	// ============================================
	// keying_config.entity_type
	// ============================================

	it("create rejects a nonexistent keying_config.entity_type", async () => {
		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create",
					slug: "ghost-entity-type",
					name: "ghost-entity-type",
					prompt: "Track things.",
					agent_id: agentId,
					keying_config: {
						entity_type: "not-a-real-type",
						entity_path: "rows",
						key_fields: ["sku"],
						key_output_field: "row_key",
					},
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Unknown entity type 'not-a-real-type'/i);
	});

	it("create accepts a keying_config.entity_type that exists", async () => {
		await workspace.owner.entity_schema.createType({
			slug: "price",
			name: "Price",
		});

		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "real-entity-type",
				name: "real-entity-type",
				prompt: "Track things.",
				agent_id: agentId,
				keying_config: {
					entity_type: "price",
					entity_path: "prices",
					key_fields: ["sku"],
					key_output_field: "price_key",
				},
			},
			TEST_ENV,
			ctx
		)) as { behavior_id: string };
		expect(created.behavior_id).toBeDefined();
	});

	it("create_version rejects a nonexistent keying_config.entity_type", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "version-entity-type",
				name: "version-entity-type",
				prompt: "Track things.",
				agent_id: agentId,
			},
			TEST_ENV,
			ctx
		)) as { behavior_id: string };

		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create_version",
					behavior_id: created.behavior_id,
					prompt: "Track things differently.",
					keying_config: {
						entity_type: "not-a-real-type",
						entity_path: "rows",
						key_fields: ["sku"],
						key_output_field: "row_key",
					},
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Unknown entity type 'not-a-real-type'/i);
	});
});
