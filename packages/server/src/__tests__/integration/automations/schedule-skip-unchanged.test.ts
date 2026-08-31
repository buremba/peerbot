import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import {
	dispatchPendingAutomationRuns,
	materializeDueAutomationRuns,
} from "../../../automations/automation";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, seedOwnerContext } from "../../setup/test-fixtures";

describe("scheduled Automation unchanged gate", () => {
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
		const created = await manageAutomations(
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
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);
		const sql = getTestDb();
		await sql`
			UPDATE automations
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${automationId}
		`;

		const result = await materializeDueAutomationRuns({} as Env, sql);

		expect(result).toMatchObject({
			dueAutomations: 1,
			runsCreated: 1,
			skipped: 0,
		});
		const dispatched = await dispatchPendingAutomationRuns({ db: sql });
		expect(dispatched).toMatchObject({ claimed: 1, reconciled: 1 });
		const runs = await sql`
			SELECT id, approved_input->>'window_start' AS window_start,
			       approved_input->>'window_end' AS window_end, run_metadata,
			       action_output, output_tail, outcome, status
			FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
		`;
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			status: "completed",
			outcome: "scoreable",
			action_output: {},
			output_tail: "No-op: scheduled source content is unchanged.",
		});
		expect(runs[0].run_metadata).toMatchObject({
			content_analyzed: 0,
			skipped_unchanged: true,
		});
		const [automation] = await sql`
			SELECT next_run_at > current_timestamp AS advanced, next_window_start
			FROM automations WHERE id = ${automationId}
		`;
		expect(automation?.advanced).toBe(true);
		expect(new Date(automation.next_window_start as string).toISOString()).toBe(
			new Date(runs[0].window_end as string).toISOString(),
		);

		const nextOccurredAt = new Date(
			new Date(runs[0].window_end as string).getTime() + 30_000,
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
			UPDATE automations
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${automationId}
		`;

		const nextResult = await materializeDueAutomationRuns({} as Env, sql);
		expect(nextResult).toMatchObject({
			dueAutomations: 1,
			runsCreated: 1,
			skipped: 0,
		});
		await dispatchPendingAutomationRuns({ db: sql });
		const [nextRun] = await sql`
			SELECT approved_input
			FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
			ORDER BY id DESC
			LIMIT 1
		`;
		expect(nextRun.approved_input).toMatchObject({
			window_start: new Date(runs[0].window_end as string).toISOString(),
		});
	});

	it("does not treat its own empty-window cursor as default-source content", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageAutomations(
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
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);
		const sql = getTestDb();
		const makeDue = () => sql`
			UPDATE automations
			SET next_run_at = current_timestamp - interval '1 minute'
			WHERE id = ${automationId}
		`;

		await makeDue();
		const first = await materializeDueAutomationRuns({} as Env, sql);
		await dispatchPendingAutomationRuns({ db: sql });
		await makeDue();
		const second = await materializeDueAutomationRuns({} as Env, sql);
		await dispatchPendingAutomationRuns({ db: sql });

		expect(first).toMatchObject({ runsCreated: 1, skipped: 0 });
		expect(second).toMatchObject({ runsCreated: 1, skipped: 0 });
		const runs = await sql`
			SELECT id, status, run_metadata FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
		`;
		expect(runs).toHaveLength(2);
		expect(runs.every((run) => run.status === "completed")).toBe(true);
		expect(
			runs.every(
				(run) =>
					(run.run_metadata as Record<string, unknown>).skipped_unchanged === true,
			),
		).toBe(true);
	});
});
