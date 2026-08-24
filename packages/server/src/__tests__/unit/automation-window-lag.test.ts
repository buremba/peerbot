/**
 * An Automation has two cursors and they advance by different rules.
 *
 * The SCHEDULE cursor (`automations.next_run_at`) is recomputed from `now`, so a
 * missed occurrence is never replayed. The WINDOW cursor
 * (`automations.next_window_start`) owns the oldest unfinished logical period.
 * It advances exactly one period after a successful completion, while lag
 * reporting describes how much closed history remains.
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
 * The guarantee: chaining advances one period and never jumps over a missing one.
 */
describe("nextAutomationWindowStart — sequential recovery", () => {
	test("a fifty-period gap returns the oldest missing period", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-06-17T00:00:00.000Z"),
			new Date("2026-08-06T09:30:00.000Z"),
			"daily",
		);
		expect(iso(next)).toBe("2026-06-18T00:00:00.000Z");
	});

	test("the next run continues chaining normally", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-08-05T00:00:00.000Z"),
			new Date("2026-08-07T09:30:00.000Z"),
			"daily",
		);
		expect(iso(next)).toBe("2026-08-06T00:00:00.000Z");
	});

	// A once-per-period Automation analyses the period that just closed.
	test("a healthy daily Automation still gets the period that just closed", () => {
		const next = nextAutomationWindowStart(
			new Date("2026-08-04T00:00:00.000Z"),
			new Date("2026-08-06T14:00:00.000Z"),
			"daily",
		);
		expect(iso(next)).toBe("2026-08-05T00:00:00.000Z");
	});

	// A sub-daily cron gets the same day every run.
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

	test("chains at every granularity", () => {
		expect(
			iso(
				nextAutomationWindowStart(
					new Date("2026-01-05T00:00:00.000Z"),
					new Date("2026-08-06T00:00:00.000Z"),
					"weekly",
				),
			),
		).toBe("2026-01-12T00:00:00.000Z");
		expect(
			iso(
				nextAutomationWindowStart(
					new Date("2026-01-01T00:00:00.000Z"),
					new Date("2026-08-06T00:00:00.000Z"),
					"monthly",
				),
			),
		).toBe("2026-02-01T00:00:00.000Z");
		expect(
			iso(
				nextAutomationWindowStart(
					new Date("2025-01-01T00:00:00.000Z"),
					new Date("2026-08-06T00:00:00.000Z"),
					"quarterly",
				),
			),
		).toBe("2025-04-01T00:00:00.000Z");
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
	// A healthy daily Automation has completed the period before the one it is
	// about to read. Lag is the age of the handed-out window, not the age of that
	// latest completion, so this is one period behind rather than two.
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

	// A caller-selected later window reports the periods it did not include.
	test("names the span omitted by an explicitly later window", () => {
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

	// Historical completions may have misaligned starts; the count must not shift.
	test("aligns a misaligned completed window before counting the skip", () => {
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
	// completed period to have jumped away from.
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

	// The current-period cap means a future window should be
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

	// Silent on every healthy run — nothing is skipped when the window follows
	// the latest completion, so there is no threshold here to tune and nothing
	// training a model to scroll past a notice it sees every time.
	test("says nothing when no periods were skipped", () => {
		expect(render(0)).not.toContain("Skipped Periods");
	});

	test("names the span omitted by an explicitly later window", () => {
		const md = render(48);
		expect(md).toContain("Skipped Periods");
		expect(md).toContain("48 daily period(s)");
		expect(md).toContain("2026-06-18T00:00:00.000Z");
		expect(md).toContain("2026-08-04T00:00:00.000Z");
	});

	test("states that the sequential cursor still owns the oldest missing period", () => {
		const md = render(48);
		expect(md).toContain("sequential Automation cursor");
		expect(md).toContain("oldest missing period");
	});

	test("does not claim the intervening periods were processed", () => {
		expect(render(48)).toContain("without treating the intervening periods as processed");
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
