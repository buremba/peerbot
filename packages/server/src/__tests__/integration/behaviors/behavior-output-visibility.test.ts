/**
 * End-to-end: what a Behavior writes is visible the moment it is written, and
 * the Behavior still does not read it back as input.
 *
 * The prod failure this closes (Behavior 71, measured 2026-08-07): every event
 * a Behavior produced was stamped `occurred_at = window_end`. `window-utils`
 * has no 'hourly' granularity, so an hourly Behavior necessarily gets the
 * CURRENT day's window and `window_end` is midnight TOMORROW for the whole day
 * it runs. Every read path bounds on `occurred_at <= now()`, so the output was
 * invisible in Memory, Activity and the Behavior page for up to 24 hours after
 * it was produced. Of 163 behavior-output events written in 30 days, 153 were
 * stamped in the future and 45 were still invisible at the time of measurement.
 *
 * The future stamp was not decoration: window membership is
 * `occurred_at >= window_start AND occurred_at < window_end`, so pushing the
 * output to the window's exclusive end is the ONLY thing that kept a Behavior
 * from re-reading its own output as input on its next run inside the same
 * window. Nothing else excluded it — there is no self-exclusion predicate in
 * the source path.
 *
 * So the timestamp cannot be fixed alone. The exclusion has to move to where
 * the decision belongs (the window's content predicate, keyed on the Behavior
 * that produced the row) before the stamp can tell the truth. This suite pins
 * both halves, because either one alone is a regression:
 *
 *   1. an output is stamped when it was produced, never in the future
 *   2. it is therefore visible to an ordinary read the moment it lands
 *   3. the producing Behavior still does not see it in its own next window
 *   4. a DIFFERENT Behavior does see it — the exclusion is self-scoped, not a
 *      blanket ban on reading behavior output
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { manageBehaviors } from "../../../tools/admin/manage_behaviors";
import { getContent } from "../../../tools/get_content";
import { handleBehaviorMode } from "../../../tools/get_content/behavior-mode";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestEntity,
	createTestEvent,
	seedOwnerContext,
} from "../../setup/test-fixtures";

const ENV = { JWT_SECRET: "test-jwt-secret-for-testing-only" } as Env;

/** The source every Behavior here reads: deliberately unfiltered, so a row the
 *  window fails to exclude comes back loudly instead of being masked by a
 *  narrow query. */
const OPEN_SOURCE =
	"SELECT id, occurred_at, semantic_type, payload_text FROM events ORDER BY occurred_at DESC";

type BehaviorContent = {
	window_token: string;
	window_start: string;
	window_end: string;
	sources: Record<string, Array<{ id: number; semantic_type: string }>>;
};

describe("A Behavior's output is visible when written and still not its own input", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let sql: DbClient;
	let producerId: number;
	let bystanderId: number;
	// Both Behaviors bind the SAME entity on purpose: the entity-scoped read
	// paths need one to be reachable at all, and sharing it means only the
	// produced_by filter can tell the two Behaviors' rows apart.
	let boundEntityId: number;

	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	const createBehavior = async (slug: string): Promise<number> => {
		const agent = await createTestAgent({
			organizationId: orgId,
			ownerUserId: userId,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug,
				name: slug,
				prompt: "Rank the day's stories.",
				agent_id: agent.agentId,
				sources: [{ name: "stories", query: OPEN_SOURCE }],
				entity_id: boundEntityId,
				// Hourly cron. `BEHAVIOR_TIME_GRANULARITIES` has no 'hourly', so this
				// resolves to a DAILY window whose end is midnight tomorrow — the exact
				// prod shape that stamped every output into the future.
				triggers: [{ kind: "schedule", cron: "25 * * * *" }],
				outputs: { signals: { event: "observation" } },
			},
			ENV,
			ctx,
		);
		if (created.action !== "create" || !("behavior_id" in created)) {
			throw new Error(`Behavior creation did not complete for ${slug}`);
		}
		return Number(created.behavior_id);
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

		producerId = await createBehavior("signal-producer");
		bystanderId = await createBehavior("signal-bystander");

		// One ordinary source row inside today's window, so a dispatch that reads
		// nothing is distinguishable from a dispatch that reads only the source.
		// Linked to the bound entity because an entity-scoped Behavior's window
		// filters on `entity_ids` — an unlinked row is invisible to it, which
		// would make the self-exclusion assertions pass against an empty window.
		await createTestEvent({
			organization_id: orgId,
			entity_ids: [boundEntityId],
			semantic_type: "message",
			content: "a story from earlier today",
			occurred_at: new Date(Date.now() - 3600_000),
		});
	});

	const dispatch = async (behaviorId: number): Promise<BehaviorContent> =>
		(await handleBehaviorMode({ behavior_id: behaviorId }, ENV, sql, {
			organizationId: orgId,
			userId,
		})) as unknown as BehaviorContent;

	const complete = async (
		behaviorId: number,
		windowToken: string,
		signals: Array<{ content: string; title: string }>,
	) => {
		const completion = await manageBehaviors(
			{
				action: "complete_window",
				behavior_id: String(behaviorId),
				window_token: windowToken,
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
	 * Advance the Behavior to the steady state that produced the prod bug.
	 *
	 * A Behavior with no cursor is handed the PREVIOUS period, whose end is
	 * already in the past — the one dispatch that never future-stamps. The bug
	 * lives in the steady state: once a completion has set the cursor to
	 * yesterday, every later dispatch that day resolves to the CURRENT, still-open
	 * period, and its `window_end` stays in the future until midnight. Prod
	 * Behavior 71 sat here all day, re-completing one open window per hour.
	 */
	const advanceToOpenWindow = async (
		behaviorId: number,
	): Promise<BehaviorContent> => {
		const warmup = await dispatch(behaviorId);
		await complete(behaviorId, warmup.window_token, []);
		const open = await dispatch(behaviorId);
		expect(open.window_start).not.toBe(warmup.window_start);
		return open;
	};

	/** Run one whole window: dispatch it, then complete it with one event output. */
	const produceSignal = async (behaviorId: number, content: string) => {
		const dispatched = await advanceToOpenWindow(behaviorId);
		await complete(behaviorId, dispatched.window_token, [
			{ content, title: content },
		]);
		return dispatched;
	};

	// Keyed on the metadata the writer stamps, not on `run_id`. `complete_window`
	// invoked directly carries no run row, so a join through `runs.watcher_id`
	// would silently return nothing and every assertion below would pass vacuously.
	const readOutputRows = async (behaviorId: number) =>
		sql<{ id: number; occurred_at: string; created_at: string }[]>`
			SELECT e.id, e.occurred_at, e.created_at
			FROM events e
			WHERE e.organization_id = ${orgId}
			  AND e.semantic_type = 'observation'
			  AND (e.metadata->>'behavior_id')::int = ${behaviorId}
			ORDER BY e.id
		`;

	// (1) THE STAMP. `window_end` is midnight tomorrow while the window is the
	// one still in progress, so the old code wrote a timestamp that had not
	// happened yet. An event's `occurred_at` is a claim about the past.
	it("stamps an output when it was produced, never in the future", async () => {
		const dispatched = await produceSignal(producerId, "Seth Rosen / X");

		// Precondition, not decoration: if the dispatched window no longer ends in
		// the future then this test has stopped exercising the prod shape and its
		// green means nothing.
		expect(new Date(dispatched.window_end).getTime()).toBeGreaterThan(
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
	// self-exclusion this Behavior now eats its own output on its next run —
	// every hour, compounding. The exclusion is the load-bearing half of the fix.
	it("does not hand a Behavior its own output back as input", async () => {
		const first = await produceSignal(producerId, "Seth Rosen / X");
		const outputs = await readOutputRows(producerId);
		expect(outputs).toHaveLength(1);
		const outputId = outputs[0].id;

		// Same day, so the same window — this is the next hourly run, not a new period.
		const second = await dispatch(producerId);
		expect(second.window_start).toBe(first.window_start);

		const seenIds = second.sources.stories.map((row) => row.id);
		expect(seenIds).not.toContain(outputId);
		// It still reads the ordinary source row, so the exclusion is a filter and
		// not an empty window.
		expect(seenIds.length).toBeGreaterThan(0);
	});

	// (4) SCOPE OF THE EXCLUSION. Self-exclusion, not a blanket ban: one
	// Behavior refining another's output is an ordinary composition, and a
	// predicate that dropped all behavior-produced rows would break it silently.
	it("still shows one Behavior's output to a different Behavior", async () => {
		await produceSignal(producerId, "Seth Rosen / X");
		const outputs = await readOutputRows(producerId);
		const outputId = outputs[0].id;

		// The bystander needs the same open window, not its own cold first
		// dispatch — that one is yesterday, which cannot contain today's output.
		const observer = await advanceToOpenWindow(bystanderId);
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
	// AND the other Behavior's row absent, since a filter dropped on the floor
	// returns a superset that a presence-only assertion happily passes.
	it("scopes to what a Behavior produced on every read path", async () => {
		await produceSignal(producerId, "Seth Rosen / X");
		await produceSignal(bystanderId, "Someone Else / LinkedIn");

		const titlesFrom = async (extra: Record<string, unknown>) => {
			const result = await getContent(
				{ produced_by_behavior_id: producerId, limit: 20, ...extra },
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
				`${pathName} path leaked another Behavior's row`,
			).not.toContain("Someone Else / LinkedIn");
		}
	});
});
