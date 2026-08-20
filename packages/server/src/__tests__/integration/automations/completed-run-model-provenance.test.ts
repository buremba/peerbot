import { describe, expect, it } from "vitest";
import {
	resolveAutomationRunsByMessageIds,
} from "../../../automations/run-completion";
import { getTestDb } from "../../setup/test-db";
import {
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

	const automation = (await workspace.owner.automations.create({
		entity_id: entity.id,
		slug: opts.slug,
		name: "Provenance Automation",
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
	})) as { automation_id: string };

	const [run] = await sql`
    INSERT INTO runs (organization_id, run_type, automation_id, status,
                      dispatched_message_id, model_used, approved_input)
    VALUES (${workspace.org.id}, 'automation', ${Number(automation.automation_id)},
            'running', ${opts.messageId}, ${opts.modelUsed},
            ${sql.json({
							dispatch_source: "scheduled",
							trigger_execution: "turn",
						})})
    RETURNING id
  `;

	return {
		runId: Number(run.id),
	};
}

async function modelUsedOf(runId: number): Promise<string | null> {
	const sql = getTestDb();
	const [row] = await sql`SELECT model_used FROM runs WHERE id = ${runId}`;
	return (row?.model_used as string | null) ?? null;
}

async function outcomeOf(runId: number): Promise<string | null> {
	const sql = getTestDb();
	const [row] = await sql`SELECT outcome FROM runs WHERE id = ${runId}`;
	return (row?.outcome as string | null) ?? null;
}

describe("a completed Automation run records who executed it", () => {
	it("replaces the 'external-client' placeholder with the real executor", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-placeholder",
			messageId: "msg-provenance-placeholder",
			modelUsed: "external-client",
		});

		await resolveAutomationRunsByMessageIds(["msg-provenance-placeholder"], {
			ok: true,
		});

		expect(await modelUsedOf(runId)).toBe("lobu-agent");
		expect(await outcomeOf(runId)).toBe("scoreable");
	});

	it("stamps a failed run's outcome from the terminal error (quota → infra_error)", async () => {
		const { runId } = await createDispatchedRun({
			slug: "outcome-quota-fail",
			messageId: "msg-outcome-quota-fail",
			modelUsed: null,
		});

		await resolveAutomationRunsByMessageIds(["msg-outcome-quota-fail"], {
			ok: false,
			error:
				"z.ai returned an error:\n429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-01",
		});

		expect(await outcomeOf(runId)).toBe("infra_error");
	});

	it("stamps a run that never had any model recorded", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-null",
			messageId: "msg-provenance-null",
			modelUsed: null,
		});

		await resolveAutomationRunsByMessageIds(["msg-provenance-null"], { ok: true });

		expect(await modelUsedOf(runId)).toBe("lobu-agent");
	});

	it("keeps a model the agent actually reported", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-reported",
			messageId: "msg-provenance-reported",
			modelUsed: "gemini-2.5-pro",
		});

		await resolveAutomationRunsByMessageIds(["msg-provenance-reported"], {
			ok: true,
		});

		expect(await modelUsedOf(runId)).toBe("gemini-2.5-pro");
	});

	it("does not invent an executor for a run that failed", async () => {
		const { runId } = await createDispatchedRun({
			slug: "provenance-failed",
			messageId: "msg-provenance-failed",
			modelUsed: "external-client",
		});

		await resolveAutomationRunsByMessageIds(["msg-provenance-failed"], {
			ok: false,
			error: "provider exploded",
		});

		// The failure path never reached the agent's completion, so the stamp
		// must not claim it did.
		expect(await modelUsedOf(runId)).toBe("external-client");
	});
});
