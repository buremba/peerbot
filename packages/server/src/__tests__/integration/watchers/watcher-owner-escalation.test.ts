/**
 * Escalation guard on manage_watchers (codex review 9, P1).
 *
 * A watcher's `agent_id` IS its policy principal — every write the watcher performs
 * folds that agent's envelope. So a NON-HUMAN caller must not be able to set/change
 * a watcher's agent_id to a DIFFERENT agent: agent A (with a deny envelope) could
 * otherwise mint/reassign a watcher owned by looser agent B and route its writes
 * through B, side-stepping A's rules. Humans are ungoverned and may assign freely.
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

/** Agent-attributed auth context (a non-human principal). */
function agentCtx(orgId: string, userId: string, agentId: string): AuthContext {
	return {
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
		memberRole: "owner",
		agentId,
		requestedAgentId: agentId,
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

async function createWatcherAs(
	ctx: AuthContext,
	agentIdForWatcher: string,
	slug: string,
) {
	return executeTool(
		"manage_watchers",
		{
			action: "create",
			slug,
			name: slug,
			prompt: "Track things.",
			agent_id: agentIdForWatcher,
		},
		TEST_ENV,
		ctx,
	);
}

describe("manage_watchers owner-escalation guard", () => {
	let workspace: TestWorkspace;
	let agentA: string;
	let agentB: string;

	beforeEach(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create();
		const a = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		const b = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		agentA = a.agentId;
		agentB = b.agentId;
	});

	it("blocks agent A from creating a watcher owned by agent B (no principal reassignment)", async () => {
		await expect(
			createWatcherAs(
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA),
				agentB,
				"escalation-attempt",
			),
		).rejects.toThrow(/cannot own a watcher via another agent/i);
	});

	it("a HUMAN may assign a watcher to any agent (ungoverned)", async () => {
		const created = (await workspace.owner.watchers.create({
			slug: "human-assigns-b",
			name: "human-assigns-b",
			prompt: "Track things.",
			agent_id: agentB,
		})) as { watcher_id: string };
		expect(created.watcher_id).toBeDefined();
	});

	it("blocks agent A from CLONING agent B's watcher via create_from_version (inherited owner)", async () => {
		// A human seeds a watcher owned by B; its v1 version_id is the clone source.
		await workspace.owner.entity_schema.createType({
			slug: "company",
			name: "Company",
		});
		const target = (await workspace.owner.entities.create({
			type: "company",
			name: "Clone Target",
		})) as { entity: { id: number } };
		const bWatcher = (await workspace.owner.watchers.create({
			slug: "b-owned-source",
			name: "b-owned-source",
			prompt: "Track things.",
			agent_id: agentB,
		})) as { watcher_id: string };
		const [ver] = await getTestDb()<{ id: number }>`
      SELECT id FROM watcher_versions WHERE watcher_id = ${Number(bWatcher.watcher_id)} ORDER BY id ASC LIMIT 1
    `;
		// Agent A clones it WITHOUT supplying agent_id — the clone would inherit B's
		// owner. The guard resolves the effective (inherited) owner and blocks it.
		await expect(
			executeTool(
				"manage_watchers",
				{
					action: "create_from_version",
					version_id: String(ver.id),
					entity_ids: [target.entity.id],
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA),
			),
		).rejects.toThrow(/cannot own a watcher via another agent/i);
	});

	it("blocks agent A from EDITING agent B's watcher (preserved owner, no agent_id)", async () => {
		const bWatcher = (await workspace.owner.watchers.create({
			slug: "b-owned-edit",
			name: "b-owned-edit",
			prompt: "Track things.",
			agent_id: agentB,
		})) as { watcher_id: string };
		// Agent A updates it WITHOUT agent_id — ownership stays B. Blocked because the
		// preserved effective owner (B) isn't A.
		await expect(
			executeTool(
				"manage_watchers",
				{
					action: "update",
					watcher_id: bWatcher.watcher_id,
					name: "renamed-by-a",
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA),
			),
		).rejects.toThrow(/cannot own a watcher via another agent/i);
	});
});
