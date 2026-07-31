import { describe, expect, it } from "vitest";
import { reconcileWatcherRuns } from "../../../watchers/automation";
import {
	resolveWatcherRunsByMessageIds,
} from "../../../watchers/run-completion";
import { getTestDb } from "../../setup/test-db";
import {
	createCanvasWindow,
	createTestAgent,
	createTestEntity,
} from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

async function createDispatchedRun(opts: {
	slug: string;
	/** NULL models a run no server dispatch ever claimed (external client). */
	messageId: string | null;
	/** Seed `model_used` as `complete_window` would have left it. */
	modelUsed: string | null;
	triggerExecution?: "turn" | "window";
}) {
	const sql = getTestDb();
	const workspace = await TestWorkspace.create({
		name: `Run Provenance ${opts.slug}`,
	});
	const entity = await createTestEntity({
		name: "Provenance Entity",
		organization_id: workspace.org.id,
		created_by: workspace.users.owner.id,
	});
	const agent = await createTestAgent({
		organizationId: workspace.org.id,
		ownerUserId: workspace.users.owner.id,
		agentId: `provenance-agent-${opts.slug}`,
		name: "Provenance Agent",
	});

	const behavior = (await workspace.owner.behaviors.create({
		entity_id: entity.id,
		slug: opts.slug,
		name: "Provenance Behavior",
		prompt: "Summarize content.",
		triggers: [
			{
				kind: "schedule",
				cron: "0 * * * *",
				execution: "window",
				active_run: "coalesce",
				skip_if_unchanged: false,
			},
		],
		agent_id: agent.agentId,
	})) as { behavior_id: string };

	const [run] = await sql`
    INSERT INTO runs (organization_id, run_type, watcher_id, status,
                      dispatched_message_id, model_used, approved_input)
    VALUES (${workspace.org.id}, 'behavior', ${Number(behavior.behavior_id)},
            'running', ${opts.messageId}, ${opts.modelUsed},
            ${sql.json({
							dispatch_source: "scheduled",
							trigger_execution: opts.triggerExecution ?? "turn",
						})})
    RETURNING id
  `;

	return {
		sql,
		runId: Number(run.id),
		organizationId: workspace.org.id,
		behaviorId: Number(behavior.behavior_id),
	};
}

async function modelUsedOf(runId: number): Promise<string | null> {
	const sql = getTestDb();
	const [row] = await sql`SELECT model_used FROM runs WHERE id = ${runId}`;
	return (row?.model_used as string | null) ?? null;
}

describe("a completed Behavior run records who executed it", () => {
	it("replaces the 'external-client' placeholder with the real executor", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-placeholder",
			messageId: "msg-provenance-placeholder",
			modelUsed: "external-client",
		});

		await resolveWatcherRunsByMessageIds(["msg-provenance-placeholder"], {
			ok: true,
		});

		expect(await modelUsedOf(runId)).toBe("lobu-agent");
	});

	it("stamps a run that never had any model recorded", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-null",
			messageId: "msg-provenance-null",
			modelUsed: null,
		});

		await resolveWatcherRunsByMessageIds(["msg-provenance-null"], { ok: true });

		expect(await modelUsedOf(runId)).toBe("lobu-agent");
	});

	it("keeps a model the agent actually reported", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-reported",
			messageId: "msg-provenance-reported",
			modelUsed: "gemini-2.5-pro",
		});

		await resolveWatcherRunsByMessageIds(["msg-provenance-reported"], {
			ok: true,
		});

		expect(await modelUsedOf(runId)).toBe("gemini-2.5-pro");
	});

	it("uses the durable dispatch marker when reconciling an existing window", async () => {
		const { sql, runId, organizationId, behaviorId } =
			await createDispatchedRun({
				slug: "provenance-reconciled",
				messageId: "msg-provenance-reconciled",
				modelUsed: "external-client",
				triggerExecution: "window",
			});

		await createCanvasWindow({
			watcherId: behaviorId,
			organizationId,
			granularity: "daily",
			windowStart: new Date("2026-07-29T00:00:00.000Z"),
			windowEnd: new Date("2026-07-30T00:00:00.000Z"),
			extractedData: { summary: "Reconciled result" },
			contentAnalyzed: 1,
			runId,
			modelUsed: "external-client",
		});

		expect((await reconcileWatcherRuns(sql)).reconciled).toBe(1);
		expect(await modelUsedOf(runId)).toBe("lobu-agent");
	});

	it("leaves an external client's run alone when reconciling", async () => {
		// reconcileWatcherRuns sweeps active runs WITHOUT filtering on
		// dispatched_message_id, so it also reaches runs an outside MCP client
		// created. Stamping those would invert the bug this file pins.
		const { sql, runId, organizationId, behaviorId } =
			await createDispatchedRun({
				slug: "provenance-external",
				messageId: null,
				modelUsed: "external-client",
				triggerExecution: "window",
			});

		await createCanvasWindow({
			watcherId: behaviorId,
			organizationId,
			granularity: "daily",
			windowStart: new Date("2026-07-29T00:00:00.000Z"),
			windowEnd: new Date("2026-07-30T00:00:00.000Z"),
			extractedData: { summary: "External result" },
			contentAnalyzed: 1,
			runId,
			modelUsed: "external-client",
		});

		expect((await reconcileWatcherRuns(sql)).reconciled).toBe(1);
		expect(await modelUsedOf(runId)).toBe("external-client");
	});

	it("does not invent an executor for a run that failed", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-failed",
			messageId: "msg-provenance-failed",
			modelUsed: "external-client",
		});

		await resolveWatcherRunsByMessageIds(["msg-provenance-failed"], {
			ok: false,
			error: "provider exploded",
		});

		// The failure path never reached the agent's completion, so the stamp
		// must not claim it did.
		expect(await modelUsedOf(runId)).toBe("external-client");
	});
});
