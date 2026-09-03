/**
 * End-to-end: an Automation that has fallen behind can see that it has, and can
 * act on it — through the real handlers against a real database.
 *
 * The prod failure this closes (Automation 2, measured 2026-08-06): a daily
 * Automation whose device stopped claiming runs fell fifty days behind. Its
 * occasional successful runs each advanced the window cursor by exactly one day
 * while the calendar advanced one day too, so the gap froze rather than closed.
 * Those runs were not failing — the late windows carry `content_analyzed = 40`.
 * It read forty real Hacker News stories and drafted replies to threads a month
 * dead, and reported success.
 *
 * The arrival axis removes the freeze rather than reporting it: there is no
 * backlog of periods to walk, so ONE run covers the whole outage and the next
 * one starts caught up. What is left to make visible is the other half — an
 * agent that deliberately reads a LATER range leaves the arrivals between the
 * mark and it unclaimed, and has to be told so in the payload it actually reads.
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
	createTestAgent,
	createTestEvent,
	seedOwnerContext,
} from "../../setup/test-fixtures";

const ENV = { JWT_SECRET: "test-jwt-secret-for-testing-only" } as Env;
const DAY_MS = 86_400_000;

/** Start of the UTC day `offsetDays` back from now. */
const dayStart = (offsetDays: number): Date => {
	const d = new Date(Date.now() - offsetDays * DAY_MS);
	d.setUTCHours(0, 0, 0, 0);
	return d;
};

type AutomationContent = {
	window_token: string;
	window_start: string;
	window_end: string;
	window_axis?: string;
	window_lag?: {
		last_window_start: string | null;
		unclaimed_from: string | null;
		unclaimed_to: string | null;
		guidance?: string;
	};
};

describe("Automation arrival lag is visible and actionable", () => {
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
				managed_agent_id: agent.agentId,
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

		// Content stored fifty days ago and content stored just now, so a window
		// that reaches either end has something real to read. This is what made
		// the prod case so quiet: the stale run DID return content.
		for (const offset of [50, 0]) {
			const at = new Date(dayStart(offset).getTime() + 3600_000);
			await createTestEvent({
				organization_id: orgId,
				semantic_type: "message",
				content: `story stored ${offset} days ago`,
				occurred_at: at,
				created_at: offset === 0 ? undefined : at,
			});
		}
	});

	/** Freeze the arrival mark `daysBack` days in the past, as an outage would. */
	const seedStaleMark = async (daysBack: number): Promise<Date> => {
		const mark = dayStart(daysBack);
		await sql`
			UPDATE automations
			SET next_window_start = ${mark.toISOString()}::timestamptz,
				last_completed_window_start = NULL
			WHERE id = ${automationId}
		`;
		return mark;
	};

	const read = async (args: Record<string, unknown> = {}) =>
		(await handleAutomationMode({ automation_id: automationId, ...args }, ENV, sql, {
			organizationId: orgId,
			userId,
		})) as AutomationContent;

	/** Run one whole window end to end: queue it, read it bound, complete it. */
	const completeWindow = async (dispatched: AutomationContent, summary: string) => {
		const run = await createAutomationRun({
			organizationId: orgId,
			automationId,
			windowStart: dispatched.window_start,
			windowEnd: dispatched.window_end,
			dispatchSource: "manual",
		});
		await sql`
			UPDATE runs
			SET status = 'running', claimed_at = NOW(), claimed_by = ${`user:${userId}`}
			WHERE id = ${run.runId}
		`;
		const bound = await read({ run_id: run.runId });
		const completion = await manageAutomations(
			{
				action: "complete_window",
				automation_id: String(automationId),
				window_token: bound.window_token,
				run_id: run.runId,
				extracted_data: { summary },
			},
			ENV,
			ctx,
		);
		expect(completion.action).toBe("complete_window");
	};

	const mark = async (): Promise<string> => {
		const [row] = await sql`
			SELECT next_window_start FROM automations WHERE id = ${automationId}
		`;
		return new Date(row.next_window_start as string).toISOString();
	};

	it("reports no last completed window for a fresh Automation", async () => {
		const content = await read();
		expect(content.window_lag?.last_window_start).toBeNull();
		// The axis travels with the bounds so a run cannot misread them as dates.
		expect(content.window_axis).toBe("created_at");
	});

	// THE FIX FOR THE PROD FAILURE. Fifty days behind used to mean fifty runs to
	// drain, one per completion, while the calendar kept moving — the gap froze.
	// One arrival window spans the entire outage.
	it("covers fifty days of backlog in a single window", async () => {
		const staleMark = await seedStaleMark(50);
		const content = await read();

		expect(content.window_start).toBe(staleMark.toISOString());
		// Reaches all the way to the horizon, not to the end of one period.
		expect(new Date(content.window_end).getTime()).toBeGreaterThan(
			Date.now() - 60_000,
		);
		expect(content.window_lag?.last_window_start).toBeNull();
		// Nothing was skipped: an ordinary read starts exactly at the mark.
		expect(content.window_lag?.unclaimed_from).toBeNull();
		expect(content.window_lag?.unclaimed_to).toBeNull();
		expect(formatToolResult("read_knowledge", content)).not.toContain(
			"Unclaimed Arrivals",
		);
	});

	it("lands caught up after one completion, not one period further on", async () => {
		const staleMark = await seedStaleMark(50);
		const dispatched = await read();
		await completeWindow(dispatched, "Analysed fifty days of arrivals.");

		// The mark moved to the end of the range that was actually read.
		expect(await mark()).toBe(dispatched.window_end);
		expect(await mark()).not.toBe(staleMark.toISOString());

		const next = await read();
		expect(next.window_start).toBe(dispatched.window_end);
		expect(next.window_lag?.last_window_start).toBe(staleMark.toISOString());
		expect(next.window_lag?.unclaimed_from).toBeNull();
	});

	// An agent that deliberately reads a LATER range is not being skipped past —
	// it chose that window. But the arrivals it stepped over stay unclaimed, and
	// the run has to be told so IN the payload: Automation runs read this through
	// run_sdk as JSON and never render the markdown.
	it("names the arrivals an explicitly later range leaves behind", async () => {
		await seedStaleMark(50);
		const target = dayStart(3);
		const date = target.toISOString().slice(0, 10);
		const content = await read({ since: date, until: date });

		expect(content.window_start).toBe(target.toISOString());
		// `until` is inclusive as the caller means it, so the exclusive end is the
		// start of the following day — never `23:59:59.999`, the convention that
		// produced prod's five zero-length windows.
		expect(content.window_end).toBe(new Date(target.getTime() + DAY_MS).toISOString());
		expect(content.window_end).not.toContain("23:59:59");

		expect(content.window_lag?.unclaimed_from).toBe(dayStart(50).toISOString());
		expect(content.window_lag?.unclaimed_to).toBe(target.toISOString());
		expect(content.window_lag?.guidance).toContain("The mark stays where it is");
		expect(formatToolResult("read_knowledge", content)).toContain(
			"Unclaimed Arrivals",
		);
	});

	// The safety property the guidance states outright, so it has to hold:
	// completing an explicitly selected later range must not book the arrivals
	// before it. Otherwise a backfill would silently discard the backlog.
	it("keeps the mark where it is when a later range is completed", async () => {
		const staleMark = await seedStaleMark(50);
		const date = dayStart(3).toISOString().slice(0, 10);
		const selected = await read({ since: date, until: date });
		await completeWindow(selected, "A deliberately selected later day.");

		expect(await mark()).toBe(staleMark.toISOString());
		// And the ordinary claim still returns the whole backlog.
		expect((await read()).window_start).toBe(staleMark.toISOString());
	});

	// The mirror case: a range entirely BEHIND the mark is a re-read. It books
	// nothing either, and reports no gap, because it skipped nothing.
	it("reports no gap for a deliberate backfill behind the mark", async () => {
		const staleMark = await seedStaleMark(50);
		const old = dayStart(60).toISOString().slice(0, 10);
		const content = await read({ since: old, until: old });

		expect(content.window_lag?.unclaimed_from).toBeNull();
		expect(content.window_lag?.unclaimed_to).toBeNull();
		expect(content.window_lag?.guidance).toBeUndefined();

		await completeWindow(content, "Re-read an old span.");
		expect(await mark()).toBe(staleMark.toISOString());
	});

	// Reads alone never advance the durable mark. An Automation whose runs all
	// fail keeps being handed the same backlog.
	it("does not advance the mark without a completed run", async () => {
		const staleMark = await seedStaleMark(50);

		await read();
		await read();

		expect(await mark()).toBe(staleMark.toISOString());
		expect((await read()).window_lag?.last_window_start).toBeNull();
	});
});
