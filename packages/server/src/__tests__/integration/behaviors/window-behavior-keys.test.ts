import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { getBehavior } from "../../../tools/get_behavior";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createCanvasWindow,
	createTestAgent,
	createTestEntity,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("Behavior window vocabulary", () => {
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

		await createCanvasWindow({
			watcherId: behaviorId,
			organizationId: org.id,
			granularity: "day",
			windowStart: "2026-07-21T00:00:00.000Z",
			windowEnd: "2026-07-22T00:00:00.000Z",
			entityIds: [entity.id],
			extractedData: { summary: "window" },
		});

		const detail = await getBehavior(
			{ behavior_id: String(behaviorId) },
			{} as Env,
			ctx,
		);
		expect(detail.windows).toHaveLength(1);

		const window = detail.windows[0];
		expect(window).not.toHaveProperty("watcher_id");
		expect(window).not.toHaveProperty("watcher_slug");
		expect(window).not.toHaveProperty("watcher_name");
		expect(String(window.behavior_id)).toBe(String(behaviorId));
		expect(window.behavior_name).toBe("Window vocab");
		expect(detail.behavior?.slug).toBe("window-vocab");
	});
});
