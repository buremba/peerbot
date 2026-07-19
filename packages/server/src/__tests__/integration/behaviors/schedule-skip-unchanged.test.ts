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

	it("persists an empty-window cursor so the next period can dispatch new data", async () => {
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

		const [skippedWindow] = await sql`
			SELECT window_start, window_end, content_analyzed
			FROM canvas_windows
			WHERE watcher_id = ${behaviorId}
		`;
		expect(skippedWindow).toMatchObject({ content_analyzed: 0 });

		const nextOccurredAt = new Date(
			new Date(skippedWindow.window_end as string).getTime() + 30_000,
		);
		await sql`
			INSERT INTO events (
				entity_ids, organization_id, origin_id, payload_type, payload_text,
				semantic_type, connector_key, occurred_at
			) VALUES (
				'{}'::bigint[], ${org.id}, 'next-period-event', 'text', 'new data',
				'content', 'never-present', ${nextOccurredAt}
			)
		`;
		await sql`
			UPDATE watchers
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${behaviorId}
		`;

		const nextResult = await materializeDueWatcherRuns({} as Env, sql);
		expect(nextResult).toMatchObject({
			dueWatchers: 1,
			runsCreated: 1,
			skipped: 0,
		});
		const [nextRun] = await sql`
			SELECT approved_input
			FROM runs
			WHERE watcher_id = ${behaviorId} AND run_type = 'watcher'
		`;
		expect(nextRun.approved_input).toMatchObject({
			window_start: new Date(skippedWindow.window_end as string).toISOString(),
		});
	});

	it("does not treat its own empty-window cursor as default-source content", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug: "empty-default-source",
				name: "Empty default source",
				prompt: "Summarize new workspace content.",
				agent_id: agent.agentId,
				triggers: [
					{
						kind: "schedule",
						cron: "* * * * *",
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
		const makeDue = () => sql`
			UPDATE watchers
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${behaviorId}
		`;

		await makeDue();
		const first = await materializeDueWatcherRuns({} as Env, sql);
		await makeDue();
		const second = await materializeDueWatcherRuns({} as Env, sql);

		expect(first).toMatchObject({ runsCreated: 0, skipped: 1 });
		expect(second).toMatchObject({ runsCreated: 0, skipped: 1 });
		const runs = await sql`
			SELECT id FROM runs
			WHERE watcher_id = ${behaviorId} AND run_type = 'watcher'
		`;
		expect(runs).toHaveLength(0);
	});
});
