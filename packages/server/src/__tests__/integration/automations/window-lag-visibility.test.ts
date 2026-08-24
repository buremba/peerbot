/**
 * End-to-end: an Automation whose window cursor has fallen behind can see that it
 * has, and can act on it — through the real handlers against a real database.
 *
 * The prod failure this closes (Automation 2, measured 2026-08-06): a daily
 * Automation whose device stopped claiming runs fell fifty days behind. Its
 * occasional successful runs each advanced the window cursor by exactly one day
 * while the calendar advanced one day too, so the gap froze rather than closed.
 * Those runs were not failing — the late windows carry `content_analyzed = 40`.
 * It read forty real Hacker News stories and drafted replies to threads a month
 * dead, and reported success. Nothing in the dispatch ever said the window was
 * stale, and from inside a run a stale window is indistinguishable from a fresh
 * one.
 *
 * Recovery is sequential: every missing logical period remains visible and a
 * successful completion advances exactly one period.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { formatToolResult } from "../../../formatting/markdown-formatter";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { handleAutomationMode } from "../../../tools/get_content/automation-mode";
import { createAutomationRun } from "../../../runs/queue-service";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createAutomationResultRun,
	createTestAgent,
	createTestEvent,
	seedOwnerContext,
} from "../../setup/test-fixtures";

const ENV = { JWT_SECRET: "test-jwt-secret-for-testing-only" } as Env;
const DAY_MS = 86_400_000;

const dayStart = (offsetDays: number): Date => {
	const d = new Date(Date.now() - offsetDays * DAY_MS);
	d.setUTCHours(0, 0, 0, 0);
	return d;
};

type AutomationContent = {
	window_token: string;
	window_start: string;
	window_end: string;
	window_lag?: {
		last_window_start: string | null;
		current_period_start: string;
		periods_behind: number;
		granularity: string;
		periods_skipped: number;
		skipped_from: string | null;
		skipped_to: string | null;
		guidance?: string;
	};
};

describe("Automation window lag is visible and actionable", () => {
	let orgId: string;
	let userId: string;
	let ctx: Awaited<ReturnType<typeof seedOwnerContext>>["ctx"];
	let automationId: number;
	let sql: DbClient;

	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		const seeded = await seedOwnerContext();
		orgId = seeded.org.id;
		userId = seeded.user.id;
		ctx = seeded.ctx;
		sql = getTestDb() as unknown as DbClient;

		const agent = await createTestAgent({
			organizationId: orgId,
			ownerUserId: userId,
		});
		const created = await manageAutomations(
			{
				action: "create",
				slug: "stale-daily",
				name: "Stale daily Automation",
				prompt: "Draft replies to the day's stories.",
				agent_id: agent.agentId,
				sources: [
					{
						name: "stories",
						query:
							"SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'message' ORDER BY occurred_at DESC",
					},
				],
				triggers: [{ kind: "schedule", cron: "0 14 * * *" }],
			},
			ENV,
			ctx,
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		automationId = Number(created.automation_id);

		// Content in both the stale period and the current one, so a window that
		// resolves to either has something real to read. This is what made the
		// prod case so quiet: the stale run DID return content.
		for (const offset of [50, 0]) {
			await createTestEvent({
				organization_id: orgId,
				semantic_type: "message",
				content: `story from ${offset} days ago`,
				occurred_at: new Date(dayStart(offset).getTime() + 3600_000),
			});
		}
	});

	/** Freeze the cursor `daysBack` days in the past, as an outage would. */
	const seedStaleCursor = async (daysBack: number) => {
		const windowStart = dayStart(daysBack);
		await createAutomationResultRun({
			automationId: automationId,
			organizationId: orgId,
			granularity: "daily",
			windowStart,
			windowEnd: new Date(windowStart.getTime() + DAY_MS),
			contentAnalyzed: 40,
			createdBy: userId,
		});
		// This fixture writes completed history directly, bypassing the completion
		// handler that maintains the durable projection. Seed the state that the
		// migration would derive from that one sequential completion.
		await sql`
			UPDATE automations
			SET next_window_start = ${new Date(windowStart.getTime() + DAY_MS).toISOString()}::timestamptz,
				completed_window_coverage = '{}'::tstzmultirange,
				window_projection_granularity = 'daily'
			WHERE id = ${automationId}
		`;
		return windowStart;
	};

	const read = async (args: Record<string, unknown> = {}) =>
		(await handleAutomationMode({ automation_id: automationId, ...args }, ENV, sql, {
			organizationId: orgId,
			userId,
		})) as AutomationContent;

	const completeSelectedDay = async (day: Date) => {
		const date = day.toISOString().slice(0, 10);
		const selected = await read({ since: date, until: date });
		const run = await createAutomationRun({
			organizationId: orgId,
			automationId,
			windowStart: selected.window_start,
			windowEnd: selected.window_end,
			dispatchSource: "manual",
		});
		await sql`
			UPDATE runs
			SET status = 'running', claimed_at = NOW(), claimed_by = ${`user:${userId}`}
			WHERE id = ${run.runId}
		`;
		await manageAutomations(
			{
				action: "complete_window",
				automation_id: String(automationId),
				window_token: selected.window_token,
				run_id: run.runId,
				extracted_data: { summary: `completed ${date}` },
			},
			ENV,
			ctx,
		);
	};

	it("reports no last completed window for a fresh Automation", async () => {
		expect((await read()).window_lag?.last_window_start).toBeNull();
	});

	it("reports the latest non-event period when windows finish out of order", async () => {
		const later = dayStart(3);
		await completeSelectedDay(later);
		await completeSelectedDay(dayStart(5));

		expect((await read()).window_lag?.last_window_start).toBe(later.toISOString());
	});

	it("dispatches the oldest missing window when fifty periods behind", async () => {
		const staleStart = await seedStaleCursor(50);
		const content = await read();

		expect(content.window_start).toBe(
			new Date(staleStart.getTime() + DAY_MS).toISOString(),
		);
		expect(content.window_lag).toBeDefined();
		expect(content.window_lag?.periods_behind).toBe(49);
		expect(content.window_lag?.last_window_start).toBe(staleStart.toISOString());
		expect(content.window_lag?.granularity).toBe("daily");
		expect(content.window_lag?.periods_skipped).toBe(0);
		expect(content.window_lag?.skipped_from).toBeNull();
		expect(content.window_lag?.skipped_to).toBeNull();
	});

	it("advances exactly one period after an ordinary completion", async () => {
		await seedStaleCursor(50);

		const dispatched = await read();
		const createdRun = await createAutomationRun({
			organizationId: orgId,
			automationId,
			windowStart: dispatched.window_start,
			windowEnd: dispatched.window_end,
			dispatchSource: "manual",
		});
		const runBound = await read({ run_id: createdRun.runId });
		const completion = await manageAutomations(
			{
				action: "complete_window",
				automation_id: String(automationId),
				window_token: runBound.window_token,
				run_id: createdRun.runId,
				extracted_data: { summary: "Analysed the dispatched window." },
			},
			ENV,
			ctx,
		);
		expect(completion.action).toBe("complete_window");

		const afterCursor = await sql`
			SELECT approved_input->>'window_start' AS window_start FROM runs
			WHERE automation_id = ${automationId}
			  AND run_type = 'automation' AND status = 'completed'
			ORDER BY (approved_input->>'window_start')::timestamptz DESC LIMIT 1
		`;
		expect(new Date(afterCursor[0].window_start as string).toISOString()).toBe(
			dayStart(49).toISOString(),
		);

		const next = await read();
		expect(next.window_start).toBe(dayStart(48).toISOString());
		expect(next.window_lag?.periods_skipped).toBe(0);
		expect(formatToolResult("read_knowledge", next)).not.toContain("Skipped Periods");
	});

	it("does not describe sequential backlog as skipped periods", async () => {
		await seedStaleCursor(50);
		const md = formatToolResult("read_knowledge", await read());

		expect(md).not.toContain("Skipped Periods");
		expect(md).toContain("Automation Window");
	});

	// The false positive this measurement was rewritten to kill. A daily Automation
	// that ran yesterday has a cursor TWO periods back at the moment its next run
	// reads — the cursor is the period the previous run completed. Prod Automation 79
	// (`0 4 * * *`) sits exactly here every day; a cursor-based threshold would
	// have warned it on every healthy run.
	it("stays silent for an Automation that is keeping up", async () => {
		await seedStaleCursor(2);
		const content = await read();

		expect(content.window_start).toBe(dayStart(1).toISOString());
		expect(content.window_lag?.periods_behind).toBe(1);
		expect(content.window_lag?.periods_skipped).toBe(0);
		expect(content.window_lag?.guidance).toBeUndefined();
		expect(formatToolResult("read_knowledge", content)).not.toContain("Skipped Periods");
	});

	it("aligns an agent-chosen range instead of storing an inclusive end", async () => {
		await seedStaleCursor(50);
		const target = dayStart(3);
		const content = await read({
			since: target.toISOString().slice(0, 10),
			until: target.toISOString().slice(0, 10),
		});

		expect(content.window_start).toBe(target.toISOString());
		// Exclusive, period-aligned — not `23:59:59.999`, the second boundary
		// convention that produced prod's five zero-length windows.
		expect(content.window_end).toBe(new Date(target.getTime() + DAY_MS).toISOString());
		expect(content.window_end).not.toContain("23:59:59");
	});

	// An agent that deliberately reads an OLD span is not being skipped past —
	// it chose that window. Reporting a skip there would be a lie, and the notice
	// would fire on every page of a deliberate backfill.
	it("reports age but no skip for a deliberate backfill read", async () => {
		const staleStart = await seedStaleCursor(50);
		const old = dayStart(60).toISOString().slice(0, 10);
		const content = await read({ since: old, until: old });

		expect(content.window_lag?.periods_behind).toBe(60);
		expect(content.window_lag?.periods_skipped).toBe(0);
		expect(content.window_lag?.guidance).toBeUndefined();
		expect(content.window_lag?.last_window_start).toBe(staleStart.toISOString());
	});

	// Backfilling an older period must never drag the cursor backwards, or
	// draining a backlog would undo the catch-up. This is the safety property the
	// guidance states outright, so it has to actually hold.
	it("keeps the cursor when an older period is backfilled afterwards", async () => {
		await seedStaleCursor(50);
		const dispatched = await read();
		const currentRun = await createAutomationRun({
			organizationId: orgId,
			automationId,
			windowStart: dispatched.window_start,
			windowEnd: dispatched.window_end,
			dispatchSource: "manual",
		});
		const currentRunBound = await read({ run_id: currentRun.runId });
		await manageAutomations(
			{
				action: "complete_window",
				automation_id: String(automationId),
				window_token: currentRunBound.window_token,
				run_id: currentRun.runId,
				extracted_data: { summary: "current" },
			},
			ENV,
			ctx,
		);

		const old = dayStart(20).toISOString().slice(0, 10);
		const backfill = await read({ since: old, until: old });
		const backfillRun = await createAutomationRun({
			organizationId: orgId,
			automationId,
			windowStart: backfill.window_start,
			windowEnd: backfill.window_end,
			dispatchSource: "manual",
		});
		const backfillRunBound = await read({ run_id: backfillRun.runId });
		await manageAutomations(
			{
				action: "complete_window",
				automation_id: String(automationId),
				window_token: backfillRunBound.window_token,
				run_id: backfillRun.runId,
				extracted_data: { summary: "backfilled" },
			},
			ENV,
			ctx,
		);

		const next = await read();
		expect(next.window_start).toBe(dayStart(48).toISOString());
		expect(next.window_lag?.periods_skipped).toBe(0);
	});

	// Reads alone never advance the durable cursor. An Automation whose runs all
	// fail keeps reporting its oldest missing period.
	it("does not advance the cursor without a completed run", async () => {
		const staleStart = await seedStaleCursor(50);

		await read();
		await read();

		const cursor = await sql`
			SELECT approved_input->>'window_start' AS window_start FROM runs
			WHERE automation_id = ${automationId}
			  AND run_type = 'automation' AND status = 'completed'
			ORDER BY (approved_input->>'window_start')::timestamptz DESC LIMIT 1
		`;
		expect(new Date(cursor[0].window_start as string).toISOString()).toBe(
			staleStart.toISOString(),
		);
		expect((await read()).window_lag?.last_window_start).toBe(staleStart.toISOString());
	});
});
