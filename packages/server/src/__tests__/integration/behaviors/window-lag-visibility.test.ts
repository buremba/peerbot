/**
 * End-to-end: a Behavior whose window cursor has fallen behind can see that it
 * has, and can act on it — through the real handlers against a real database.
 *
 * The prod failure this closes (Behavior 2, measured 2026-08-06): a daily
 * Behavior whose device stopped claiming runs fell fifty days behind. Its
 * occasional successful runs each advanced the window cursor by exactly one day
 * while the calendar advanced one day too, so the gap froze rather than closed.
 * Those runs were not failing — the late windows carry `content_analyzed = 40`.
 * It read forty real Hacker News stories and drafted replies to threads a month
 * dead, and reported success. Nothing in the dispatch ever said the window was
 * stale, and from inside a run a stale window is indistinguishable from a fresh
 * one.
 *
 * The fix is a floor in the dispatch, not a hint to the run: a Behavior is never
 * handed a window older than one period, so the gap closes on the next successful
 * run whatever model is driving it. Telling the run about the skip is what is
 * left over — the one decision that is genuinely its own.
 *
 * So this suite proves, in order:
 *   1. a lagging Behavior is dispatched the CURRENT window, not cursor + 1
 *   2. one completion of that window collapses fifty days of backlog
 *   3. the skipped span is named, in JSON and in the markdown a model reads
 *   4. none of it fires on a healthy Behavior
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { formatToolResult } from "../../../formatting/markdown-formatter";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { handleBehaviorMode } from "../../../tools/get_content/behavior-mode";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createCanvasWindow,
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

type BehaviorContent = {
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

describe("Behavior window lag is visible and actionable", () => {
	let orgId: string;
	let userId: string;
	let ctx: Awaited<ReturnType<typeof seedOwnerContext>>["ctx"];
	let behaviorId: number;
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
		const created = await manageBehaviors(
			{
				action: "create",
				slug: "stale-daily",
				name: "Stale daily Behavior",
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
		if (created.action !== "create" || !("behavior_id" in created)) {
			throw new Error("Behavior creation did not complete");
		}
		behaviorId = Number(created.behavior_id);

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
		await createCanvasWindow({
			watcherId: behaviorId,
			organizationId: orgId,
			granularity: "daily",
			windowStart,
			windowEnd: new Date(windowStart.getTime() + DAY_MS),
			contentAnalyzed: 40,
			createdBy: userId,
		});
		return windowStart;
	};

	const read = async (args: Record<string, unknown> = {}) =>
		(await handleBehaviorMode({ behavior_id: behaviorId, ...args }, ENV, sql, {
			organizationId: orgId,
			userId,
		})) as BehaviorContent;

	// THE FIX, at the dispatch. The old rule handed this run `staleStart + 1` —
	// June 18 for a Behavior sitting in August — and needed fifty more successful
	// runs to reach the present. No agent cooperation is involved here.
	it("dispatches the current window, not cursor + 1, when fifty periods behind", async () => {
		const staleStart = await seedStaleCursor(50);
		const content = await read();

		expect(content.window_start).toBe(dayStart(1).toISOString());
		expect(content.window_start).not.toBe(
			new Date(staleStart.getTime() + DAY_MS).toISOString(),
		);
		expect(content.window_lag).toBeDefined();
		// The WINDOW is one period old — the healthy resting value. The cursor is
		// still fifty back until something completes.
		expect(content.window_lag?.periods_behind).toBe(1);
		expect(content.window_lag?.last_window_start).toBe(staleStart.toISOString());
		expect(content.window_lag?.granularity).toBe("daily");
		// June 18 through August 4, in prod's terms: everything between the cursor
		// and the window now being handed out.
		expect(content.window_lag?.periods_skipped).toBe(48);
		expect(content.window_lag?.skipped_from).toBe(dayStart(49).toISOString());
		expect(content.window_lag?.skipped_to).toBe(dayStart(2).toISOString());
	});

	// THE PAYOFF. One ordinary completion of the ordinary dispatched window —
	// no `since`/`until`, no notice acted on, nothing the model had to work out.
	it("collapses fifty days of backlog in one ordinary run", async () => {
		await seedStaleCursor(50);

		const dispatched = await read();
		const completion = await manageBehaviors(
			{
				action: "complete_window",
				behavior_id: String(behaviorId),
				window_token: dispatched.window_token,
				extracted_data: { summary: "Analysed the dispatched window." },
			},
			ENV,
			ctx,
		);
		expect(completion.action).toBe("complete_window");

		const afterCursor = await sql`
			SELECT window_start FROM canvas_windows
			WHERE watcher_id = ${behaviorId}
			ORDER BY window_start DESC LIMIT 1
		`;
		expect(new Date(afterCursor[0].window_start as string).toISOString()).toBe(
			dayStart(1).toISOString(),
		);

		// And it stays closed: the next dispatch chains normally instead of
		// sticking to the floor, and the skip notice goes quiet.
		const next = await read();
		expect(next.window_start).toBe(dayStart(0).toISOString());
		expect(next.window_lag?.periods_skipped).toBe(0);
		expect(formatToolResult("read_knowledge", next)).not.toContain("Skipped Periods");
	});

	it("names the skipped span in the markdown a model actually reads", async () => {
		await seedStaleCursor(50);
		const md = formatToolResult("read_knowledge", await read());

		expect(md).toContain("Skipped Periods");
		expect(md).toContain("48 daily period(s)");
		// The affordance — a run that is not told it may read the span back will
		// never read it back.
		expect(md).toContain("since");
		expect(md).toContain("until");
		// `watcher` is internal DB vocabulary and must not reach an agent surface.
		expect(md.toLowerCase()).not.toContain("watcher");
	});

	// The false positive this measurement was rewritten to kill. A daily Behavior
	// that ran yesterday has a cursor TWO periods back at the moment its next run
	// reads — the cursor is the period the previous run completed. Prod Behavior 79
	// (`0 4 * * *`) sits exactly here every day; a cursor-based threshold would
	// have warned it on every healthy run.
	it("stays silent for a Behavior that is keeping up", async () => {
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
		await manageBehaviors(
			{
				action: "complete_window",
				behavior_id: String(behaviorId),
				window_token: dispatched.window_token,
				extracted_data: { summary: "current" },
			},
			ENV,
			ctx,
		);

		const old = dayStart(20).toISOString().slice(0, 10);
		const backfill = await read({ since: old, until: old });
		await manageBehaviors(
			{
				action: "complete_window",
				behavior_id: String(behaviorId),
				window_token: backfill.window_token,
				extracted_data: { summary: "backfilled" },
			},
			ENV,
			ctx,
		);

		const next = await read();
		expect(next.window_start).toBe(dayStart(0).toISOString());
		expect(next.window_lag?.last_window_start).toBe(dayStart(1).toISOString());
		expect(next.window_lag?.periods_skipped).toBe(0);
	});

	// The floor moves what is ASKED FOR, never what was DONE. A Behavior whose
	// runs all fail keeps reporting its real cursor, so catching up cannot be
	// mistaken for a Behavior that is actually working.
	it("does not advance the cursor without a completed run", async () => {
		const staleStart = await seedStaleCursor(50);

		await read();
		await read();

		const cursor = await sql`
			SELECT window_start FROM canvas_windows
			WHERE watcher_id = ${behaviorId}
			ORDER BY window_start DESC LIMIT 1
		`;
		expect(new Date(cursor[0].window_start as string).toISOString()).toBe(
			staleStart.toISOString(),
		);
		expect((await read()).window_lag?.last_window_start).toBe(staleStart.toISOString());
	});
});
