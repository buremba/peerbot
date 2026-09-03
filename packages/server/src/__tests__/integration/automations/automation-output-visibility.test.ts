/**
 * End-to-end: what an Automation writes is visible the moment it is written, and
 * the Automation still does not read it back as input.
 *
 * The prod failure this closes (Automation 71, measured 2026-08-07): every event
 * an Automation produced was stamped `occurred_at = window_end`. `window-utils`
 * has no 'hourly' granularity, so an hourly Automation necessarily gets the
 * CURRENT day's window and `window_end` is midnight TOMORROW for the whole day
 * it runs. Every read path bounds on `occurred_at <= now()`, so the output was
 * invisible in Memory, Activity and the Automation page for up to 24 hours after
 * it was produced. Of 163 automation-output events written in 30 days, 153 were
 * stamped in the future and 45 were still invisible at the time of measurement.
 *
 * The future stamp was not decoration: window membership was then
 * `occurred_at >= window_start AND occurred_at < window_end` (it is
 * `created_at` today), so pushing the
 * output to the window's exclusive end is the ONLY thing that kept an Automation
 * from re-reading its own output as input on its next run inside the same
 * window. Nothing else excluded it — there is no self-exclusion predicate in
 * the source path.
 *
 * So the timestamp cannot be fixed alone. The exclusion has to move to where
 * the decision belongs (the window's content predicate, keyed on the Automation
 * that produced the row) before the stamp can tell the truth. This suite pins
 * both halves, because either one alone is a regression:
 *
 *   1. an output is stamped when it was produced, never in the future
 *   2. it is therefore visible to an ordinary read the moment it lands
 *   3. the producing Automation still does not see it in its own next window,
 *      nor in any LATER one — the exclusion keys on provenance, not on window
 *      position, which is a real semantic change: the old `window_end` stamp
 *      landed exactly on the next window's start, so an Automation DID re-read its
 *      own prior-period output
 *   4. a DIFFERENT Automation does see it — the exclusion is self-scoped, not a
 *      blanket ban on reading automation output
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { createAutomationRun } from "../../../runs/queue-service";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { getContent } from "../../../tools/get_content";
import { handleAutomationMode } from "../../../tools/get_content/automation-mode";
import type { ToolContext } from "../../../tools/registry";
import { insertEvent } from "../../../utils/insert-event";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestEntity,
	createTestEvent,
	seedOwnerContext,
} from "../../setup/test-fixtures";

const ENV = { JWT_SECRET: "test-jwt-secret-for-testing-only" } as Env;

/** The source every Automation here reads: deliberately unfiltered, so a row the
 *  window fails to exclude comes back loudly instead of being masked by a
 *  narrow query. */
const OPEN_SOURCE =
	"SELECT id, occurred_at, semantic_type, payload_text FROM events ORDER BY occurred_at DESC";

type AutomationContent = {
	window_token: string;
	window_start: string;
	window_end: string;
	sources: Record<string, Array<{ id: number; semantic_type: string }>>;
};

describe("An Automation's output is visible when written and still not its own input", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let sql: DbClient;
	let producerId: number;
	let bystanderId: number;
	// Both Automations bind the SAME entity on purpose: the entity-scoped read
	// paths need one to be reachable at all, and sharing it means only the
	// produced_by filter can tell the two Automations' rows apart.
	let boundEntityId: number;

	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	const createAutomation = async (slug: string): Promise<number> => {
		const agent = await createTestAgent({
			organizationId: orgId,
			ownerUserId: userId,
		});
		const created = await manageAutomations(
			{
				action: "create",
				slug,
				name: slug,
				prompt: "Rank the day's stories.",
				managed_agent_id: agent.agentId,
				sources: [{ name: "stories", query: OPEN_SOURCE }],
				entity_id: boundEntityId,
				// The cadence no longer shapes the window: on the arrival axis a run
				// covers everything stored since the last completion, whatever the cron.
				triggers: [{ kind: "schedule", cron: "25 * * * *" }],
				outputs: { signals: { event: "observation" } },
			},
			ENV,
			ctx,
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error(`Automation creation did not complete for ${slug}`);
		}
		return Number(created.automation_id);
	};

	beforeEach(async () => {
		await cleanupTestDatabase();
		const seeded = await seedOwnerContext();
		orgId = seeded.org.id;
		userId = seeded.user.id;
		ctx = seeded.ctx;
		sql = getTestDb() as unknown as DbClient;

		boundEntityId = (
			await createTestEntity({
				name: "Signal Desk",
				organization_id: orgId,
				created_by: userId,
			})
		).id;

		producerId = await createAutomation("signal-producer");
		bystanderId = await createAutomation("signal-bystander");


		// One ordinary source row inside today's window, so a dispatch that reads
		// nothing is distinguishable from a dispatch that reads only the source.
		// Linked to the bound entity because an entity-scoped Automation's window
		// filters on `entity_ids` — an unlinked row is invisible to it, which
		// would make the self-exclusion assertions pass against an empty window.
		// Derive the timestamp from the UTC daily boundary: `now - 1 hour` belongs
		// to yesterday when CI runs between 00:00 and 01:00 UTC, which made this
		// fixture disappear from the exact current window it was meant to exercise.
		await createTestEvent({
			organization_id: orgId,
			entity_ids: [boundEntityId],
			semantic_type: "message",
			content: "a story from earlier today",
			occurred_at: new Date(),
		});
	});

	const dispatch = async (
		automationId: number,
		args: Record<string, unknown> = {},
	): Promise<AutomationContent> =>
		(await handleAutomationMode({ automation_id: automationId, ...args }, ENV, sql, {
			organizationId: orgId,
			userId,
		})) as unknown as AutomationContent;

	/** Create the run that owns the dispatched period and read the run-bound token
	 *  that may atomically claim it during completion. */
	const bindRunToWindow = async (
		automationId: number,
		dispatched: AutomationContent,
	): Promise<{ runId: number; windowToken: string }> => {
		const queued = await createAutomationRun({
			organizationId: orgId,
			automationId,
			windowStart: dispatched.window_start,
			windowEnd: dispatched.window_end,
			dispatchSource: "scheduled",
		});
		const runBound = await dispatch(automationId, { run_id: queued.runId });
		expect(runBound.window_start).toBe(dispatched.window_start);
		expect(runBound.window_end).toBe(dispatched.window_end);
		return { runId: queued.runId, windowToken: runBound.window_token };
	};

	const complete = async (
		automationId: number,
		dispatched: AutomationContent,
		signals: Array<{ content: string; title: string }>,
	) => {
		const runBound = await bindRunToWindow(automationId, dispatched);
		const completion = await manageAutomations(
			{
				action: "complete_window",
				automation_id: String(automationId),
				run_id: runBound.runId,
				window_token: runBound.windowToken,
				extracted_data: {
					signals: signals.map((s) => ({
						...s,
						metadata: { kind: "social_signal" },
					})),
				},
			},
			ENV,
			ctx,
		);
		expect(completion.action).toBe("complete_window");
	};

	/**
	 * Put the Automation in its steady state: one completion behind it, so the
	 * next dispatch starts at a mark this test moved rather than at the
	 * Automation's creation instant.
	 *
	 * The prod bug this suite was written for lived in the calendar axis, where
	 * the second dispatch of the day resolved to the still-open CURRENT period
	 * and stamped its output at `window_end` — midnight tomorrow. The arrival
	 * axis has no open period: a window always ends at the horizon, already in
	 * the past. The steady state still matters, because it is the state in which
	 * an Automation's own output lands INSIDE the range the next run claims.
	 */
	const advanceToSteadyState = async (
		automationId: number,
	): Promise<AutomationContent> => {
		const warmup = await dispatch(automationId);
		await complete(automationId, warmup, []);
		const next = await dispatch(automationId);
		// The completion moved the mark to the warmup's end.
		expect(next.window_start).toBe(warmup.window_end);
		return next;
	};

	/** Run one whole window: dispatch it, then complete it with one event output. */
	const produceSignal = async (automationId: number, content: string) => {
		const dispatched = await advanceToSteadyState(automationId);
		await complete(automationId, dispatched, [{ content, title: content }]);
		return dispatched;
	};

	// Use the event's physical Automation attribution rather than duplicating the
	// run lookup or relying on client-visible metadata.
	const readOutputRows = async (automationId: number) =>
		sql<{ id: number; occurred_at: string; created_at: string }[]>`
			SELECT e.id, e.occurred_at, e.created_at
			FROM events e
			WHERE e.organization_id = ${orgId}
			  AND e.semantic_type = 'observation'
			  AND e.automation_id = ${automationId}
			ORDER BY e.id
		`;

	// (1) THE STAMP. A calendar `window_end` was midnight tomorrow while the
	// window was still in progress, so the old code wrote a timestamp that had
	// not happened yet. An event's `occurred_at` is a claim about the past.
	//
	// The arrival axis removes the hazard at the source rather than clamping it:
	// a window ends at the horizon, which is behind the clock by construction.
	// Pinned here so a future change that lets `window_end` run ahead of `now()`
	// fails loudly instead of quietly reintroducing the future stamp.
	it("stamps an output when it was produced, never in the future", async () => {
		const dispatched = await produceSignal(producerId, "Seth Rosen / X");

		expect(new Date(dispatched.window_end).getTime()).toBeLessThanOrEqual(
			Date.now(),
		);

		const rows = await readOutputRows(producerId);
		expect(rows).toHaveLength(1);
		expect(new Date(rows[0].occurred_at).getTime()).toBeLessThanOrEqual(
			Date.now(),
		);
		expect(new Date(rows[0].occurred_at).getTime()).toBeLessThanOrEqual(
			new Date(rows[0].created_at).getTime(),
		);
	});

	// (2) THE POINT OF THE STAMP. Every read path carries
	// `AND (occurred_at IS NULL OR occurred_at <= now())`, so a future stamp is
	// not a cosmetic wrong date — it removes the row from the product.
	it("returns the output from an ordinary read the moment it lands", async () => {
		await produceSignal(producerId, "Jacopo Tagliabue / X");

		const result = await getContent(
			{ semantic_type: "observation", limit: 20 },
			ENV,
			ctx,
		);
		const titles = result.content.map((item) => item.title);
		expect(titles).toContain("Jacopo Tagliabue / X");
	});

	// (3) WHAT THE FUTURE STAMP WAS SILENTLY BUYING. The window predicate is
	// `occurred_at >= start AND occurred_at < end`, so a truthful stamp puts the
	// output squarely inside the window that produced it. Without an explicit
	// self-exclusion this Automation now eats its own output on its next run —
	// every hour, compounding. The exclusion is the load-bearing half of the fix.
	it("does not hand an Automation its own output back as input", async () => {
		const first = await produceSignal(producerId, "Seth Rosen / X");
		const outputs = await readOutputRows(producerId);
		expect(outputs).toHaveLength(1);
		const outputId = outputs[0].id;

		// An ordinary row stored AFTER that completion, so the next window is not
		// empty for a reason unrelated to the exclusion.
		const ordinary = await createTestEvent({
			organization_id: orgId,
			entity_ids: [boundEntityId],
			semantic_type: "message",
			content: "a story that landed after the completion",
			occurred_at: new Date(),
		});

		// The completion moved the mark to the window it booked, so the next run
		// covers exactly the span the output landed in — the hardest case for the
		// exclusion, not the easiest.
		const second = await dispatch(producerId);
		expect(second.window_start).toBe(first.window_end);

		const seenIds = second.sources.stories.map((row) => row.id);
		expect(seenIds).not.toContain(outputId);
		// It still reads the ordinary source row, so the exclusion is a filter and
		// not an empty window.
		expect(seenIds).toContain(Number(ordinary.id));
	});

	// (3b) THE EXCLUSION IS BY PROVENANCE, NOT BY POSITION. Keying on
	// `automation_id` excludes an Automation's output from EVERY window, not only
	// the one that wrote it. Pinned explicitly because test (3) alone would still
	// pass if the exclusion were somehow scoped to the producing window.
	//
	// On the arrival axis the hazard is sharper than it was on the calendar one:
	// an output is STORED after the window that produced it, so it always lands
	// inside the range the next run claims. Position can never save this — only
	// provenance can.
	it("keeps excluding its own output in a later window, not just the one that wrote it", async () => {
		await advanceToSteadyState(producerId);

		// Written through the real writer, attributed to this Automation, and
		// dated well in the past — a prior period's output as it looks once it is
		// no longer the current window's own work.
		const priorOccurredAt = new Date(Date.now() - 60 * 60 * 1000);
		const priorPeriodOutput = await insertEvent({
			entityIds: [boundEntityId],
			organizationId: orgId,
			originId: `automation:${producerId}:output:prior-period:${priorOccurredAt.getTime()}`,
			title: "Output from an earlier period",
			content: "Output from an earlier period",
			semanticType: "observation",
			occurredAt: priorOccurredAt,
			automationId: producerId,
		});
		// An ordinary row stored alongside it, so an empty window cannot be
		// mistaken for a working exclusion.
		const ordinary = await createTestEvent({
			organization_id: orgId,
			entity_ids: [boundEntityId],
			semantic_type: "message",
			content: "an ordinary story stored in the same span",
			occurred_at: priorOccurredAt,
		});

		// Precondition, read back from the row rather than assumed: it really is
		// attributed to this Automation, and it really was STORED inside the range
		// about to be dispatched. Otherwise a pass would mean the window missed it,
		// not that the predicate excluded it.
		const next = await dispatch(producerId);
		const [stored] = await sql<{ created_at: string; automation_id: number }[]>`
			SELECT created_at, automation_id FROM events WHERE id = ${Number(priorPeriodOutput.id)}
		`;
		expect(Number(stored.automation_id)).toBe(producerId);
		expect(new Date(stored.created_at).getTime()).toBeGreaterThanOrEqual(
			new Date(next.window_start).getTime(),
		);
		expect(new Date(stored.created_at).getTime()).toBeLessThan(
			new Date(next.window_end).getTime(),
		);

		const seenIds = next.sources.stories.map((row) => row.id);
		expect(seenIds).not.toContain(Number(priorPeriodOutput.id));
		expect(seenIds).toContain(Number(ordinary.id));
	});

	// (4) SCOPE OF THE EXCLUSION. Self-exclusion, not a blanket ban: one
	// Automation refining another's output is an ordinary composition, and a
	// predicate that dropped all automation-produced rows would break it silently.
	it("still shows one Automation's output to a different Automation", async () => {
		await produceSignal(producerId, "Seth Rosen / X");
		const outputs = await readOutputRows(producerId);
		const outputId = outputs[0].id;

		// The bystander's own first dispatch is the one that covers the producer's
		// output: its mark sits at its creation, before the producer ever ran, so
		// [mark, horizon) spans everything stored since. Warming it up first would
		// book that span away and leave nothing to observe.
		const observer = await dispatch(bystanderId);
		expect(observer.sources.stories.map((row) => row.id)).toContain(outputId);
	});

	// (5) THE FILTER, ON EVERY PATH THAT SERVES IT.
	//
	// `read_knowledge` fans out to four independently assembled SQL builders —
	// chronological list, text/vector search, score-ranked, and the exact
	// include-superseded read — each with its own hand-threaded positional
	// params. A filter wired into some of them is worse than one wired into
	// none: the SAME scope silently returns different rows depending on whether
	// the user happened to type a search term. So assert each path by the shape
	// that routes to it, and assert both directions — the producer's row present
	// AND the other Automation's row absent, since a filter dropped on the floor
	// returns a superset that a presence-only assertion happily passes.
	it("scopes to what an Automation produced on every read path", async () => {
		await produceSignal(producerId, "Seth Rosen / X");
		await produceSignal(bystanderId, "Someone Else / LinkedIn");

		const titlesFrom = async (extra: Record<string, unknown>) => {
			const result = await getContent(
				{ produced_by_automation_id: producerId, limit: 20, ...extra },
				ENV,
				ctx,
			);
			return result.content.map((item) => item.title);
		};

		for (const [pathName, extra] of [
			["list", {}],
			["search", { query: "Rosen" }],
			// Both of these are entity-scoped by contract — the handler rejects
			// include_superseded without an entity_id, and score ranking only
			// engages for one.
			["include_superseded", { include_superseded: true, entity_id: boundEntityId }],
			["score", { sort_by: "score", entity_id: boundEntityId }],
		] as const) {
			const titles = await titlesFrom(extra);
			expect(titles, `${pathName} path lost the producer's row`).toContain(
				"Seth Rosen / X",
			);
			expect(
				titles,
				`${pathName} path leaked another Automation's row`,
			).not.toContain("Someone Else / LinkedIn");
		}
	});

	// (6) THE OPPOSITE DIRECTION, ON THE SAME FOUR PATHS.
	//
	// `analyzed_by_automation_id` means "linked into one of this Automation's
	// windows" — what it READ, not what it wrote. Two of the four builders
	// dropped it: the chronological list path applied it only inside its
	// classification-filter branch, and the search path never applied it. So an
	// unqualified `?automation=<id>` drill — which routes to the standard list
	// branch — returned the whole org stream with a 200. The score and
	// include-superseded builders already bound it; they are covered here so
	// the four paths cannot drift apart again.
	//
	// The load-bearing assertion is the NEGATIVE one. A dropped filter returns a
	// superset, and against real data a superset still contains the rows you
	// expected — which is exactly why this went unnoticed. An id that matches
	// nothing must return nothing; if it returns rows, the filter is not being
	// applied at all.
	it("scopes to what an Automation analyzed on every read path", async () => {
		await produceSignal(producerId, "Seth Rosen / X");

		const countFrom = async (
			automationId: number,
			extra: Record<string, unknown>,
		) => {
			const result = await getContent(
				{ analyzed_by_automation_id: automationId, limit: 20, ...extra },
				ENV,
				ctx,
			);
			return result.content.length;
		};

		// Two negatives, because they fail differently. 99999 exists nowhere, so
		// it catches a filter that was dropped outright. `bystanderId` is a REAL
		// Automation in the same org that simply never ran — it catches a filter
		// that resolves to something permissive (a join that widens, an id that
		// falls back to "any Automation") while still looking applied.
		const NO_SUCH_AUTOMATION = 99999;

		for (const [pathName, extra] of [
			["list", {}],
			// "story", not "Rosen": this filter selects what the Automation READ, and
			// the only row in its window is the seeded source event. "Rosen" matches
			// the row it WROTE, so that intersection is empty for the right reason
			// and would make this path assert nothing.
			["search", { query: "story" }],
			["include_superseded", { include_superseded: true, entity_id: boundEntityId }],
			["score", { sort_by: "score", entity_id: boundEntityId }],
		] as const) {
			expect(
				await countFrom(NO_SUCH_AUTOMATION, extra),
				`${pathName} path ignored analyzed_by_automation_id and returned unfiltered rows`,
			).toBe(0);
			expect(
				await countFrom(bystanderId, extra),
				`${pathName} path returned rows for an Automation that analyzed nothing`,
			).toBe(0);
			expect(
				await countFrom(producerId, extra),
				`${pathName} path lost the rows the Automation actually analyzed`,
			).toBeGreaterThan(0);
		}
	});
});
