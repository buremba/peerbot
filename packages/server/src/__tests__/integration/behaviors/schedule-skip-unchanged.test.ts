import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { materializeDueWatcherRuns } from "../../../watchers/automation";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, seedOwnerContext } from "../../setup/test-fixtures";

describe("scheduled Behavior unchanged gate", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("advances an empty schedule without creating an agent run", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug: "empty-minute-batch",
				name: "Empty minute batch",
				prompt: "Summarize newly landed GitHub content.",
				agent_id: agent.agentId,
				sources: [
					{
						name: "github",
						query:
							"SELECT id, payload_text FROM events WHERE connector_key = 'never-present' ORDER BY occurred_at DESC",
					},
				],
				triggers: [
					{
						kind: "schedule",
						cron: "* * * * *",
						execution: "window",
						active_run: "coalesce",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("watcher_id" in created)) {
			throw new Error("Behavior creation did not complete");
		}
		const behaviorId = Number(created.watcher_id);
		const sql = getTestDb();
		await sql`
			UPDATE watchers
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${behaviorId}
		`;

		const result = await materializeDueWatcherRuns({} as Env, sql);

		expect(result).toMatchObject({
			dueWatchers: 1,
			runsCreated: 0,
			skipped: 1,
		});
		const runs = await sql`
			SELECT id FROM runs
			WHERE watcher_id = ${behaviorId} AND run_type = 'watcher'
		`;
		expect(runs).toHaveLength(0);
		const [watcher] = await sql`
			SELECT next_run_at > current_timestamp AS advanced
			FROM watchers WHERE id = ${behaviorId}
		`;
		expect(watcher?.advanced).toBe(true);
	});
});
