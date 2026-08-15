/**
 * An Automation has two cursors and they advance by different rules.
 *
 * The SCHEDULE cursor (`automations.next_run_at`) is recomputed from `now`, so a
 * missed occurrence is never replayed. The WINDOW cursor
 * (`max(canvas_windows.window_start)`) advances one period per COMPLETED window.
 * Wall-clock moves one period per period, so under pure chaining an Automation that
 * falls behind stays behind: the gap freezes at whatever width the outage left
 * it, and closing it would take one successful run per missed period.
 *
 * Prod Automation 2 ("HN engagement — draft replies", daily) measured 2026-08-06:
 * newest window `2026-06-17`, written by a run on `2026-07-15`. Drift by window,
 * monotonic — covers 06-06 written 06-11 (5d), 06-14 written 06-27 (13d), 06-15
 * written 07-08 (23d), 06-17 written 07-15 (28d). It was not failing: those late
 * windows carry `content_analyzed = 40`. It read forty real Hacker News stories
 * and drafted real replies to threads a month dead, and reported success.
 *
 * The fix is a FLOOR in `nextAutomationWindowStart`: never hand out a window older
 * than one period. That closes any gap in a single run without the agent having
 * to notice anything, which is the only form of this fix that holds for every
 * model. What the run is then told is the span the server skipped, and the one
 * decision left to it — whether that span is worth reading back.
 */

import { describe, expect, test } from "bun:test";
import { formatToolResult } from "../../formatting/markdown-formatter";
import {
	alignRequestedWindow,
	computeWindowLag,
	describeWindowLag,
	nextAutomationWindowStart,
	parseAutomationWindowDate,
} from "../../utils/window-utils";

const iso = (d: Date) => d.toISOString();

// `alignRequestedWindow` is pure UTC — every boundary in window-utils is
// `setUTC*`, and the local zone is normalized away earlier by
// `parseAutomationWindowDate`. So its fixtures are UTC instants, and these
// assertions hold identically under every TZ.
const utcDate = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
	new Date(Date.UTC(y, mo - 1, d, h, mi, s));

/**
 * The guarantee. Everything else in this file reports; only this closes the gap,
 * and it does so without the agent participating at all.
 */
describe("nextAutomationWindowStart — the floor", () => {
	// THE REGRESSION. Prod Automation 2: cursor at June 17, clock at August 6.
	// Chaining alone hands out June 18 and would need fifty more successful runs
	// to reach the present. The floor hands out yesterday, once.
	test("a fifty-period gap closes in one run", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-06-17T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(iso(next)).toBe("2026-08-05T00:00:00.000Z");
		expect(iso(next)).not.toBe("2026-06-18T00:00:00.000Z");
	});

	// ...and stays closed. The run after the catch-up chains normally rather than
	// sticking to the floor, which is what makes this a one-off correction and not
	// an Automation permanently pinned to yesterday.
	test("the run after a catch-up chains normally", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-08-05T00:00:00.000Z"),
			new Date("2026-08-07T09:30:00.000Z"),
			"daily",
		);
		expect(iso(next)).toBe("2026-08-06T00:00:00.000Z");
	});

	// The healthy steady state must be untouched: a once-per-period Automation
	// analyses the period that just closed. If the floor moved this to "today" it
	// would hand every daily Automation a half-finished period.
	test("a healthy daily Automation still gets the period that just closed", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-08-04T00:00:00.000Z"),
			new Date("2026-08-06T14:00:00.000Z"),
			"daily",
		);
		expect(iso(next)).toBe("2026-08-05T00:00:00.000Z");
	});

	// A sub-daily cron gets the SAME day every run so `replace_existing` can
	// refresh it. The floor must not push this backwards to yesterday.
	test("a sub-period cron keeps resolving to the current period", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-08-06T00:00:00.000Z"),
			new Date("2026-08-06T14:00:00.000Z"),
			"daily",
		);
		expect(iso(next)).toBe("2026-08-06T00:00:00.000Z");
	});

	test("never hands out a future window", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-09-01T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(next.getTime()).toBeLessThanOrEqual(Date.UTC(2026, 7, 6));
	});

	test("a fresh Automation starts one aligned period back", () => {
		expect(iso(nextAutomationWindowStart(null, new Date("2026-08-06T14:00:00.000Z"), "daily"))).toBe(
			"2026-08-05T00:00:00.000Z",
		);
	});

	// `setUTCMonth(month - 1)` on a 31st rolls FORWARD — Feb 31 becomes Mar 3 —
	// so subtracting a period from the raw `now` handed a monthly Automation run on
	// the 31st the month it was already on. Aligning first is what fixes it.
	test("a monthly Automation on the 31st gets the previous month, not this one", () => {
		expect(
			iso(nextAutomationWindowStart(null, new Date("2026-03-31T12:00:00.000Z"), "monthly")),
		).toBe("2026-02-01T00:00:00.000Z");
	});

	test("floors at every granularity", () => {
		// Weekly: 2026-08-03 is the Monday of the current week, so the floor is the
		// Monday before it.
		expect(
			iso(
				nextAutomationWindowStart(
					new Date("2026-01-05T00:00:00.000Z"),
					new Date("2026-08-06T00:00:00.000Z"),
					"weekly",
				),
			),
		).toBe("2026-07-27T00:00:00.000Z");
		expect(
			iso(
				nextAutomationWindowStart(
					new Date("2026-01-01T00:00:00.000Z"),
					new Date("2026-08-06T00:00:00.000Z"),
					"monthly",
				),
			),
		).toBe("2026-07-01T00:00:00.000Z");
		expect(
			iso(
				nextAutomationWindowStart(
					new Date("2025-01-01T00:00:00.000Z"),
					new Date("2026-08-06T00:00:00.000Z"),
					"quarterly",
				),
			),
		).toBe("2026-04-01T00:00:00.000Z");
	});

	// A corrupt stored start must not propagate. Prod holds 14 windows written
	// with an inclusive `23:59:59.999` end and misaligned starts.
	test("re-aligns a misaligned stored cursor", () => {
		expect(
			iso(
				nextAutomationWindowStart(
					new Date("2026-08-04T23:59:59.999Z"),
					new Date("2026-08-06T14:00:00.000Z"),
					"daily",
				),
			),
		).toBe("2026-08-05T00:00:00.000Z");
	});
});

describe("computeWindowLag", () => {
	// THE FALSE POSITIVE this measurement was rewritten to kill. Measured against
	// the CURSOR, a perfectly healthy daily Automation reads as two periods behind
	// at the moment its run calls read_knowledge — the cursor is the period the
	// PREVIOUS run completed. Prod Automation 79 (`0 4 * * *`) sits exactly here
	// every day, so any cursor-based threshold fires on healthy runs. Measured
	// against the WINDOW being handed out, it is one.
	test("a healthy daily Automation is one period behind, not two", () => {
		const lag = computeWindowLag(
			new Date("2026-08-04T00:00:00.000Z"),
			new Date("2026-08-05T00:00:00.000Z"),
			new Date("2026-08-06T14:00:00.000Z"),
			"daily",
		);
		expect(lag.periodsBehind).toBe(1);
		expect(lag.periodsSkipped).toBe(0);
		expect(lag.skippedFrom).toBeNull();
		expect(iso(lag.currentPeriodStart)).toBe("2026-08-06T00:00:00.000Z");
	});

	test("a sub-period cron on the current window reads as zero", () => {
		const lag = computeWindowLag(
			new Date("2026-08-06T00:00:00.000Z"),
			new Date("2026-08-06T00:00:00.000Z"),
			new Date("2026-08-06T14:00:00.000Z"),
			"daily",
		);
		expect(lag.periodsBehind).toBe(0);
		expect(lag.periodsSkipped).toBe(0);
	});

	// The prod case after the floor: cursor still at June 17, window now August 5,
	// so June 18 through August 4 — 48 days — are skipped and named.
	test("names the span the floor skipped", () => {
		const lag = computeWindowLag(
			new Date("2026-06-17T00:00:00.000Z"),
			new Date("2026-08-05T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(lag.periodsBehind).toBe(1);
		expect(lag.periodsSkipped).toBe(48);
		expect(iso(lag.skippedFrom as Date)).toBe("2026-06-18T00:00:00.000Z");
		expect(iso(lag.skippedTo as Date)).toBe("2026-08-04T00:00:00.000Z");
	});

	// A deliberate backfill read is not a skip: the agent asked for an old window,
	// so it is genuinely old, and nothing was jumped over to produce it.
	test("an agent-chosen backfill window reports age but no skip", () => {
		const lag = computeWindowLag(
			new Date("2026-08-04T00:00:00.000Z"),
			new Date("2026-06-17T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(lag.periodsBehind).toBe(50);
		expect(lag.periodsSkipped).toBe(0);
	});

	// Prod holds windows stored with misaligned starts; the count must not shift.
	test("aligns a misaligned stored cursor before counting the skip", () => {
		const lag = computeWindowLag(
			new Date("2026-06-17T23:59:59.999Z"),
			new Date("2026-08-05T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(lag.periodsSkipped).toBe(48);
	});

	test("counts whole periods at every granularity", () => {
		expect(
			computeWindowLag(
				null,
				new Date("2026-06-01T00:00:00.000Z"),
				new Date("2026-08-06T00:00:00.000Z"),
				"weekly",
			).periodsBehind,
		).toBe(9);
		expect(
			computeWindowLag(
				null,
				new Date("2026-02-15T00:00:00.000Z"),
				new Date("2026-08-06T00:00:00.000Z"),
				"monthly",
			).periodsBehind,
		).toBe(6);
		expect(
			computeWindowLag(
				null,
				new Date("2025-11-15T00:00:00.000Z"),
				new Date("2026-08-06T00:00:00.000Z"),
				"quarterly",
			).periodsBehind,
		).toBe(3);
	});

	// An Automation that has never completed a window skipped nothing — there is no
	// cursor to have jumped away from.
	test("an Automation with no windows yet has skipped nothing", () => {
		const lag = computeWindowLag(
			null,
			new Date("2026-08-05T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(lag.periodsSkipped).toBe(0);
		expect(lag.skippedFrom).toBeNull();
		expect(lag.skippedTo).toBeNull();
	});

	// The floor caps at the current period, so a future window should be
	// impossible — but prod has held future-dated rows and a negative age would
	// render as nonsense.
	test("a window ahead of the clock clamps to zero, never negative", () => {
		const lag = computeWindowLag(
			null,
			new Date("2026-09-01T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(lag.periodsBehind).toBe(0);
	});
});

describe("alignRequestedWindow", () => {
	// The regression. `toEndOfDay` produced `23:59:59.999`, the INCLUSIVE
	// convention that `computePendingWindow` documents as the source of prod's
	// five zero-length windows — and it disagrees with the `>= start AND < end`
	// filter `executeDataSources` applies, so the last millisecond of the range
	// was silently excluded from the events it read.
	test("the end is exclusive, not 23:59:59.999", () => {
		const { windowEnd } = alignRequestedWindow(
			utcDate(2026, 6, 1),
			utcDate(2026, 6, 30),
			"daily",
		);
		expect(iso(windowEnd)).toBe("2026-07-01T00:00:00.000Z");
		expect(iso(windowEnd)).not.toContain("23:59:59");
	});

	// A multi-period span is the whole point: the unprocessed-ranges formatter
	// tells a daily Automation to read whole months. Aligning must not collapse
	// that to one day.
	test("preserves a multi-period span", () => {
		const { windowStart, windowEnd } = alignRequestedWindow(
			utcDate(2026, 6, 1),
			utcDate(2026, 6, 30),
			"daily",
		);
		expect(iso(windowStart)).toBe("2026-06-01T00:00:00.000Z");
		expect(windowEnd.getTime() - windowStart.getTime()).toBe(30 * 86_400_000);
	});

	test("a mid-period start is aligned down to the period boundary", () => {
		const { windowStart } = alignRequestedWindow(
			utcDate(2026, 6, 17, 13, 45, 12),
			utcDate(2026, 6, 17, 13, 45, 12),
			"daily",
		);
		expect(iso(windowStart)).toBe("2026-06-17T00:00:00.000Z");
	});

	// since === until means "just this period", and must yield a real period
	// rather than the zero-length window that broke five prod rows.
	test("a single-period request yields exactly one period", () => {
		const { windowStart, windowEnd } = alignRequestedWindow(
			utcDate(2026, 6, 17),
			utcDate(2026, 6, 17, 23),
			"daily",
		);
		expect(iso(windowStart)).toBe("2026-06-17T00:00:00.000Z");
		expect(iso(windowEnd)).toBe("2026-06-18T00:00:00.000Z");
	});

	// An inverted range must not produce a window that ends before it starts.
	test("an inverted range degrades to one period, never negative", () => {
		const { windowStart, windowEnd } = alignRequestedWindow(
			utcDate(2026, 6, 17),
			utcDate(2026, 6, 1),
			"daily",
		);
		expect(windowEnd.getTime()).toBeGreaterThan(windowStart.getTime());
		expect(iso(windowEnd)).toBe("2026-06-18T00:00:00.000Z");
	});

	test("monthly granularity spans whole months", () => {
		const { windowStart, windowEnd } = alignRequestedWindow(
			utcDate(2026, 6, 17),
			utcDate(2026, 8, 2),
			"monthly",
		);
		expect(iso(windowStart)).toBe("2026-06-01T00:00:00.000Z");
		expect(iso(windowEnd)).toBe("2026-09-01T00:00:00.000Z");
	});
});

/**
 * The JSON field is the contract; this markdown is what an LLM run actually
 * reads. A field the model never sees fixes nothing, so the rendered surface is
 * pinned here too — including the sentence that tells the run it may choose a
 * different span, which is the entire point of the change.
 */
describe("read_knowledge markdown — skipped periods", () => {
	// Built exactly as automation-mode builds it, guidance included — the formatter
	// renders the SAME string the JSON payload carries, so a fixture without it
	// would test a shape production never emits.
	const lagFor = (periodsSkipped: number) => {
		const guidance = describeWindowLag({
			skippedFrom: periodsSkipped > 0 ? new Date("2026-06-18T00:00:00.000Z") : null,
			skippedTo: periodsSkipped > 0 ? new Date("2026-08-04T00:00:00.000Z") : null,
			periodsSkipped,
			granularity: "daily",
		});
		return {
			last_window_start: "2026-06-17T00:00:00.000Z",
			current_period_start: "2026-08-06T00:00:00.000Z",
			periods_behind: 1,
			granularity: "daily",
			periods_skipped: periodsSkipped,
			skipped_from: periodsSkipped > 0 ? "2026-06-18T00:00:00.000Z" : null,
			skipped_to: periodsSkipped > 0 ? "2026-08-04T00:00:00.000Z" : null,
			...(guidance ? { guidance } : {}),
		};
	};

	const render = (periodsSkipped: number) =>
		formatToolResult("read_knowledge", {
			total: 40,
			content: [],
			page: { limit: 100, offset: 0, has_more: false },
			window_token: "tok",
			window_start: "2026-08-05T00:00:00.000Z",
			window_end: "2026-08-06T00:00:00.000Z",
			window_lag: lagFor(periodsSkipped),
		});

	// Silent on every healthy run — nothing is skipped when the window chains
	// straight off the cursor, so there is no threshold here to tune and nothing
	// training a model to scroll past a notice it sees every time.
	test("says nothing when no periods were skipped", () => {
		expect(render(0)).not.toContain("Skipped Periods");
	});

	test("names the skipped span once the floor has jumped", () => {
		const md = render(48);
		expect(md).toContain("Skipped Periods");
		expect(md).toContain("48 daily period(s)");
		expect(md).toContain("2026-06-18T00:00:00.000Z");
		expect(md).toContain("2026-08-04T00:00:00.000Z");
	});

	test("tells the run it can read the skipped span back", () => {
		const md = render(48);
		expect(md).toContain("since");
		expect(md).toContain("until");
		expect(md).toContain("read_knowledge");
	});

	// The safety property is the reason a run can act on this without risk, so it
	// has to be stated, not implied.
	test("states that a backfill cannot drag the cursor back", () => {
		expect(render(48)).toContain("cannot make this Automation stale again");
	});

	test("an Automation with no lag field renders unchanged", () => {
		const md = formatToolResult("read_knowledge", {
			total: 0,
			content: [],
			page: { limit: 100, offset: 0, has_more: false },
			window_token: "tok",
			window_start: "2026-08-06T00:00:00.000Z",
			window_end: "2026-08-07T00:00:00.000Z",
		});
		expect(md).toContain("Automation Window");
		expect(md).not.toContain("Skipped Periods");
	});
});

/**
 * `get_automation.pending_analysis.next_action` hands an MCP client a literal
 * `read_knowledge` call for the window it just previewed. That suggestion has to
 * round-trip: feeding its `since`/`until` back through `alignRequestedWindow`
 * must reproduce the previewed window exactly, or the server is telling clients
 * to write windows the dispatcher would never emit.
 *
 * It did not. `until` was `next_window.end` — the EXCLUSIVE boundary — so a
 * one-day window was advertised as a two-day range.
 */
describe("next_action round-trips to the previewed window", () => {
	// Mirrors the construction in get_automation.ts: `until` is the last instant
	// inside the window, rendered as a date.
	const suggest = (start: string, end: string) => ({
		since: start.split("T")[0],
		until: new Date(new Date(end).getTime() - 1).toISOString().split("T")[0],
	});

	test.each([
		["daily", "2026-06-18T00:00:00.000Z", "2026-06-19T00:00:00.000Z"],
		["weekly", "2026-06-15T00:00:00.000Z", "2026-06-22T00:00:00.000Z"],
		["monthly", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
		["quarterly", "2026-04-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
	] as const)("%s", (granularity, start, end) => {
		const { since, until } = suggest(start, end);
		const round = alignRequestedWindow(
			parseAutomationWindowDate(since),
			parseAutomationWindowDate(until),
			granularity,
		);
		expect(iso(round.windowStart)).toBe(start);
		expect(iso(round.windowEnd)).toBe(end);
	});

	// The bug, pinned directly: the exclusive end as `until` widens by a period.
	test("passing the exclusive end as until widens the window", () => {
		const wrong = alignRequestedWindow(
			parseAutomationWindowDate("2026-06-18"),
			parseAutomationWindowDate("2026-06-19"),
			"daily",
		);
		expect(iso(wrong.windowEnd)).toBe("2026-06-20T00:00:00.000Z");
	});
});

/**
 * The timezone trap, pinned. `parseDateAlias` returns midnight in the SERVER's
 * local zone; window boundaries are UTC. East of UTC that local midnight is
 * still the PREVIOUS UTC day, so aligning it with `setUTCHours` wrote the
 * 2026-08-05 window for "give me 2026-08-06" — and `get_automation.next_action`
 * hands clients exactly such a date string, so the server's own suggestion did
 * not round-trip on an east-of-UTC deployment. (West of UTC the day is lost
 * inside parseDateAlias's ISO branch before alignment ever runs — that trap is
 * shared with every `since`/`until` consumer and out of this branch's reach.)
 *
 * Only the e2e caught this; every unit assertion above passes in UTC either way.
 */
describe("parseAutomationWindowDate is timezone-stable", () => {
	// `bun test` runs with TZ=UTC, where a local date and a UTC date are the same
	// instant — so this suite is only meaningful under an explicit TZ. Run it as:
	//   TZ=America/New_York bun test src/__tests__/unit/automation-window-lag.test.ts
	//   TZ=Europe/Istanbul  bun test ...
	// Both must be green. The previous version of this block fed `new Date(y,m,d)`
	// into the aligner and asserted a UTC day; under TZ=UTC that is a tautology,
	// which is exactly how the production bug survived every unit test.
	test("a bare YYYY-MM-DD is that UTC day, in any zone", () => {
		expect(iso(parseAutomationWindowDate("2026-08-06"))).toBe("2026-08-06T00:00:00.000Z");
		expect(iso(parseAutomationWindowDate("2026-01-01"))).toBe("2026-01-01T00:00:00.000Z");
		// Whitespace is tolerated the same way parseDateAlias tolerates it.
		expect(iso(parseAutomationWindowDate("  2026-08-06 "))).toBe("2026-08-06T00:00:00.000Z");
	});

	test("the window it produces is that day, in any zone", () => {
		const day = parseAutomationWindowDate("2026-08-06");
		const { windowStart, windowEnd } = alignRequestedWindow(day, day, "daily");
		expect(iso(windowStart)).toBe("2026-08-06T00:00:00.000Z");
		expect(iso(windowEnd)).toBe("2026-08-07T00:00:00.000Z");
	});

	// Aliases are relative to the server clock by definition; what must hold is
	// that the day they land on is expressed as UTC midnight, never a local one.
	test("an alias resolves to a UTC midnight", () => {
		const today = parseAutomationWindowDate("today");
		expect(today.getUTCHours()).toBe(0);
		expect(today.getUTCMinutes()).toBe(0);
		expect(today.getUTCSeconds()).toBe(0);
		expect(today.getUTCMilliseconds()).toBe(0);
	});
});
