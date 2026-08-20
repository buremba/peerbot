import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { getAutomation } from "../../../tools/get_automation";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createAutomationResultRun,
	createTestAgent,
	createTestEntity,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("Automation window vocabulary", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("returns canonical automation_* keys", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const entity = await createTestEntity({
			name: "Window Vocab Co",
			organization_id: org.id,
		});
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageAutomations(
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

		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);
		expect(Number.isFinite(automationId)).toBe(true);

		await createAutomationResultRun({
			automationId: automationId,
			organizationId: org.id,
			granularity: "day",
			windowStart: "2026-07-21T00:00:00.000Z",
			windowEnd: "2026-07-22T00:00:00.000Z",
			entityIds: [entity.id],
			extractedData: { summary: "window" },
		});

		const detail = await getAutomation(
			{ automation_id: String(automationId) },
			{} as Env,
			ctx,
		);
		expect(detail.windows).toHaveLength(1);

		const window = detail.windows[0];
		expect(String(window.automation_id)).toBe(String(automationId));
		expect(window.automation_name).toBe("Window vocab");
		expect(detail.automation?.slug).toBe("window-vocab");
	});
});
