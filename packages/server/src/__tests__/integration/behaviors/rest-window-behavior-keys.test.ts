import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createCanvasWindow,
	createTestAccessToken,
	createTestAgent,
	createTestEntity,
	createTestOAuthClient,
	seedOwnerContext,
} from "../../setup/test-fixtures";
import { get } from "../../setup/test-helpers";

describe("REST behavior window vocabulary", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("returns behavior_* keys and no watcher_* keys", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const entity = await createTestEntity({
			name: "Window Vocab Co",
			organization_id: org.id,
		});
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				entity_id: entity.id,
				slug: "window-vocab",
				name: "Window vocab",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				sources: [
					{
						name: "src",
						query: "SELECT id FROM events WHERE connector_key = 'none'",
					},
				],
			},
			{} as Env,
			ctx,
		);

		if (created.action !== "create" || !("behavior_id" in created)) {
			throw new Error("Behavior creation did not complete");
		}
		const behaviorId = Number(created.behavior_id);
		expect(Number.isFinite(behaviorId)).toBe(true);

		const windowId = await createCanvasWindow({
			watcherId: behaviorId,
			organizationId: org.id,
			granularity: "day",
			windowStart: "2026-07-21T00:00:00.000Z",
			windowEnd: "2026-07-22T00:00:00.000Z",
			entityIds: [entity.id],
			extractedData: { summary: "window" },
		});

		const client = await createTestOAuthClient({ client_name: "Test" });
		const login = await createTestAccessToken(
			user.id,
			org.id,
			client.client_id,
			{
				scope: "mcp:read mcp:write",
			},
		);

		const response = await get(
			`/api/${org.slug}/behaviors/windows/${windowId}`,
			{ token: login.token },
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("watcher_id");
		expect(body).not.toHaveProperty("watcher_slug");
		expect(body).not.toHaveProperty("watcher_name");
		expect(String(body.behavior_id)).toBe(String(behaviorId));
		expect(body.behavior_slug).toBe("window-vocab");
		expect(body.behavior_name).toBe("Window vocab");
	});
});
