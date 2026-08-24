/**
 * Window utilities for automation time windows
 *
 * Computes pending window dates based on schedule (cron) or granularity label.
 */

import {
  addAutomationPeriod,
  alignToAutomationWindowStart,
  subtractAutomationPeriod,
  type AutomationTimeGranularity,
} from '@lobu/connector-sdk';
import type { DbClient } from '../db/client';
import { parseDateAlias } from './date-aliases';
import type { UnprocessedRange } from '../types/automations';

interface WindowDates {
  windowStart: Date;
  windowEnd: Date;
  /**
   * The latest completed non-event window, handed back so a caller that also
   * reports lag does not re-query the projection this function just read.
   */
  lastCompletedWindowStart: Date | null;
}

/** Row shape for a `DATE_TRUNC('month', ...)` aggregate of total events per month. */
interface MonthlyTotalRow {
  month: string | Date;
  total: number | string;
}

/** Row shape for a `DATE_TRUNC('month', ...)` aggregate of linked events per month. */
interface MonthlyLinkedRow {
  month: string | Date;
  linked: number | string;
}

/**
 * Fold two month-bucketed aggregates — total events per month vs. events linked
 * to an automation's windows per month — into the `UnprocessedRange[]` histogram.
 *
 * Shared by `get_content` (Automation mode) and `get_automation` (pending analysis).
 *
 * @param includeComplete when true, months with zero unprocessed content are
 *   still emitted (with `status: 'complete'`). When false, only months with
 *   unprocessed content are emitted. `get_content` passes true; `get_automation`
 *   passes false.
 */
export function foldUnprocessedRanges(
  monthlyTotals: Iterable<MonthlyTotalRow>,
  monthlyLinked: Iterable<MonthlyLinkedRow>,
  includeComplete: boolean
): UnprocessedRange[] {
  const linkedByMonth = new Map<string, number>();
  for (const row of monthlyLinked) {
    const monthKey = new Date(row.month as string).toISOString().slice(0, 7);
    linkedByMonth.set(monthKey, Number(row.linked));
  }

  const ranges: UnprocessedRange[] = [];
  for (const row of monthlyTotals) {
    const monthDate = new Date(row.month as string);
    const monthKey = monthDate.toISOString().slice(0, 7);
    const total = Number(row.total);
    const linked = linkedByMonth.get(monthKey) || 0;
    const unprocessed = total - linked;

    if (!includeComplete && unprocessed <= 0) continue;

    const rangeStart = new Date(monthDate);
    const rangeEnd = new Date(monthDate);
    rangeEnd.setMonth(rangeEnd.getMonth() + 1);
    rangeEnd.setMilliseconds(-1);

    let status: UnprocessedRange['status'];
    if (linked === 0) {
      status = 'unprocessed';
    } else if (unprocessed === 0) {
      status = 'complete';
    } else {
      status = 'partial';
    }

    ranges.push({
      month: monthKey,
      window_start: rangeStart.toISOString(),
      window_end: rangeEnd.toISOString(),
      total_content: total,
      processed_content: linked,
      unprocessed_content: unprocessed,
      status,
    });
  }
  return ranges;
}

/**
 * Compute the pending window dates for an automation.
 *
 * Returns a period-aligned window of exactly one granularity period:
 * `[aligned start, start + 1 period)`. The end is EXCLUSIVE.
 *
 * Reads the durable oldest-unfinished cursor. The migration owns legacy history
 * reconstruction; runtime work is bounded to the Automation-row projection.
 */
export async function computePendingWindow(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity
): Promise<WindowDates> {
  const readProjection = async (client: DbClient) => {
    const windowStart = await ensureExpectedAutomationWindowStart(
      client,
      automationId,
      granularity
    );
    const lastCompletedWindowStart = await readLastCompletedWindowStart(
      client,
      automationId,
      granularity
    );
    return { windowStart, lastCompletedWindowStart };
  };
  const projection =
    typeof sql.savepoint === 'function'
      ? await readProjection(sql)
      : await sql.begin(readProjection);
  const { windowStart, lastCompletedWindowStart } = projection;

  // Always a full period. `windowStart <= alignedNow` by construction, so this
  // can never exceed the current period's end and never needs clamping — which
  // is what keeps it from degenerating.
  const windowEnd = addAutomationPeriod(windowStart, granularity);

  return { windowStart, windowEnd, lastCompletedWindowStart };
}

/** Read the durable expected period without consulting run history. */
export async function readExpectedAutomationWindowStart(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity,
  now: Date = new Date()
): Promise<Date> {
  const [automation] = await sql<{
    next_window_start: string | Date | null;
    window_projection_granularity: string | null;
  }>`
    SELECT next_window_start, window_projection_granularity
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
  if (
    automation?.next_window_start &&
    (automation.window_projection_granularity == null ||
      automation.window_projection_granularity === granularity)
  ) {
    return alignToAutomationWindowStart(new Date(automation.next_window_start), granularity);
  }
  return nextAutomationWindowStart(null, now, granularity);
}

/**
 * Lock and initialize the compact scheduled-coverage projection.
 *
 * Product creation and schedule-edit paths write this state explicitly. The
 * fallback exists for direct test fixtures and rows created while this branch's
 * migration is being exercised; it is bounded to the Automation row and never
 * reconstructs history.
 */
export async function ensureExpectedAutomationWindowStart(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity,
  now: Date = new Date()
): Promise<Date> {
  const inTransaction = typeof sql.savepoint === 'function';
  return inTransaction
    ? ensureExpectedAutomationWindowStartLocked(sql, automationId, granularity, now)
    : sql.begin((tx) =>
        ensureExpectedAutomationWindowStartLocked(tx, automationId, granularity, now)
      );
}

async function ensureExpectedAutomationWindowStartLocked(
  tx: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity,
  now: Date
): Promise<Date> {
  const [automation] = await tx<{
    next_window_start: string | Date | null;
    window_projection_granularity: string | null;
  }>`
    SELECT next_window_start, window_projection_granularity
    FROM automations
    WHERE id = ${automationId}
    FOR UPDATE
  `;
  const initial = nextAutomationWindowStart(null, now, granularity);
  if (!automation) return initial;
  if (
    !automation.next_window_start ||
    automation.window_projection_granularity !== granularity
  ) {
    await tx`
      UPDATE automations
      SET next_window_start = ${initial.toISOString()}::timestamptz,
          completed_window_coverage = '{}'::tstzmultirange,
          window_projection_granularity = ${granularity},
          last_completed_window_start = NULL
      WHERE id = ${automationId}
    `;
    return initial;
  }

  const expected = alignToAutomationWindowStart(
    new Date(automation.next_window_start),
    granularity
  );
  const closedBoundary = alignToAutomationWindowStart(now, granularity);
  if (expected >= closedBoundary) return expected;

  const [covered] = await tx<{ covered_until: string | Date | null }>`
    SELECT upper(component) AS covered_until
    FROM automations automation
    CROSS JOIN LATERAL unnest(automation.completed_window_coverage) component
    WHERE automation.id = ${automationId}
      AND component @> ${expected.toISOString()}::timestamptz
    LIMIT 1
  `;
  if (!covered?.covered_until) return expected;

  const advanced = new Date(
    Math.min(new Date(covered.covered_until).getTime(), closedBoundary.getTime())
  );
  await tx`
    UPDATE automations
    SET next_window_start = ${advanced.toISOString()}::timestamptz,
        completed_window_coverage = completed_window_coverage
          * tstzmultirange(tstzrange(${advanced.toISOString()}::timestamptz, NULL, '[)'))
    WHERE id = ${automationId}
  `;
  return advanced;
}

/** Merge a completed scheduled period, advance across contiguous coverage, and prune behind it. */
export async function advanceExpectedAutomationWindow(
  sql: DbClient,
  automationId: number,
  completedWindowStart: Date,
  granularity: AutomationTimeGranularity,
  now: Date = new Date()
): Promise<boolean> {
  const inTransaction = typeof sql.savepoint === 'function';
  return inTransaction
    ? advanceExpectedAutomationWindowLocked(
        sql,
        automationId,
        completedWindowStart,
        granularity,
        now
      )
    : sql.begin((tx) =>
        advanceExpectedAutomationWindowLocked(
          tx,
          automationId,
          completedWindowStart,
          granularity,
          now
        )
      );
}

async function advanceExpectedAutomationWindowLocked(
  tx: DbClient,
  automationId: number,
  completedWindowStart: Date,
  granularity: AutomationTimeGranularity,
  now: Date
): Promise<boolean> {
  const [storedProjection] = await tx<{
    next_window_start: string | Date | null;
    window_projection_granularity: string | null;
  }>`
    SELECT next_window_start, window_projection_granularity
    FROM automations
    WHERE id = ${automationId}
    FOR UPDATE
  `;
  if (
    storedProjection?.next_window_start != null &&
    storedProjection.window_projection_granularity != null &&
    storedProjection.window_projection_granularity !== granularity
  ) {
    return false;
  }

  const expected = await ensureExpectedAutomationWindowStartLocked(
    tx,
    automationId,
    granularity,
    now
  );
  const completedStart = alignToAutomationWindowStart(completedWindowStart, granularity);
  const completedEnd = addAutomationPeriod(completedStart, granularity);
  const closedBoundary = alignToAutomationWindowStart(now, granularity);
  const [updated] = await tx<{ next_window_start: string | Date }>`
    WITH projected AS (
      SELECT
        next_window_start AS cursor,
        completed_window_coverage
          + tstzmultirange(tstzrange(
              ${completedStart.toISOString()}::timestamptz,
              ${completedEnd.toISOString()}::timestamptz,
              '[)'
            )) AS coverage
      FROM automations
      WHERE id = ${automationId}
    ), resolved AS (
      SELECT
        cursor,
        coverage,
        CASE
          WHEN cursor < ${closedBoundary.toISOString()}::timestamptz THEN LEAST(
            COALESCE((
              SELECT upper(component)
              FROM unnest(coverage) component
              WHERE component @> cursor
              LIMIT 1
            ), cursor),
            ${closedBoundary.toISOString()}::timestamptz
          )
          ELSE cursor
        END AS next_cursor
      FROM projected
    )
    UPDATE automations automation
    SET next_window_start = resolved.next_cursor,
        completed_window_coverage = resolved.coverage
          * tstzmultirange(tstzrange(resolved.next_cursor, NULL, '[)')),
        window_projection_granularity = ${granularity},
        last_completed_window_start = GREATEST(
          automation.last_completed_window_start,
          ${completedStart.toISOString()}::timestamptz
        ),
        updated_at = current_timestamp
    FROM resolved
    WHERE automation.id = ${automationId}
    RETURNING automation.next_window_start
  `;
  return Boolean(updated) && new Date(updated.next_window_start).getTime() !== expected.getTime();
}

export const MAX_AUTOMATION_PENDING_GAPS = 50;

export interface AutomationPendingProjection {
  nextWindowStart: Date;
  closedBoundary: Date;
  pendingPeriodCount: number;
  missingRanges: Array<{ start: Date; end: Date }>;
  missingRangeCount: number;
  gapsTruncated: boolean;
}

interface PendingProjectionRow {
  next_window_start: string | Date;
  projection_granularity: string | null;
  pending_period_count: string | number;
  missing_range_count: string | number;
  gap_start: string | Date | null;
  gap_end: string | Date | null;
}

/**
 * Read exact pending scheduled coverage from one compact Automation row.
 * Work is proportional to stored multirange components, never elapsed periods
 * or historical runs, and only the first bounded set of gaps crosses the wire.
 */
export async function readAutomationPendingProjection(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity,
  now: Date = new Date(),
  gapLimit: number = MAX_AUTOMATION_PENDING_GAPS
): Promise<AutomationPendingProjection> {
  const closedBoundary = alignToAutomationWindowStart(now, granularity);
  const initial = nextAutomationWindowStart(null, now, granularity);
  const rows = await sql<PendingProjectionRow>`
    WITH projection AS (
      SELECT
        COALESCE(next_window_start, ${initial.toISOString()}::timestamptz) AS next_window_start,
        window_projection_granularity AS projection_granularity,
        CASE
          WHEN window_projection_granularity IS NULL THEN '{}'::tstzmultirange
          ELSE completed_window_coverage
        END AS completed_window_coverage
      FROM automations
      WHERE id = ${automationId}
    ), missing_projection AS (
      SELECT
        next_window_start,
        projection_granularity,
        CASE
          WHEN next_window_start < ${closedBoundary.toISOString()}::timestamptz THEN
            tstzmultirange(tstzrange(
              next_window_start,
              ${closedBoundary.toISOString()}::timestamptz,
              '[)'
            )) - completed_window_coverage
          ELSE '{}'::tstzmultirange
        END AS missing
      FROM projection
    ), metrics AS (
      SELECT
        COALESCE(sum(
          CASE ${granularity}
            WHEN 'daily' THEN
              extract(epoch FROM (upper(gap) - lower(gap))) / 86400
            WHEN 'weekly' THEN
              extract(epoch FROM (upper(gap) - lower(gap))) / 604800
            WHEN 'monthly' THEN
              (extract(year FROM upper(gap) AT TIME ZONE 'UTC') - extract(year FROM lower(gap) AT TIME ZONE 'UTC')) * 12
              + extract(month FROM upper(gap) AT TIME ZONE 'UTC') - extract(month FROM lower(gap) AT TIME ZONE 'UTC')
            ELSE (
              (extract(year FROM upper(gap) AT TIME ZONE 'UTC') - extract(year FROM lower(gap) AT TIME ZONE 'UTC')) * 12
              + extract(month FROM upper(gap) AT TIME ZONE 'UTC') - extract(month FROM lower(gap) AT TIME ZONE 'UTC')
            ) / 3
          END
        ), 0)::bigint AS pending_period_count,
        count(gap)::bigint AS missing_range_count
      FROM missing_projection
      CROSS JOIN LATERAL unnest(missing) gap
    )
    SELECT
      projection.next_window_start,
      projection.projection_granularity,
      metrics.pending_period_count,
      metrics.missing_range_count,
      lower(reported.gap) AS gap_start,
      upper(reported.gap) AS gap_end
    FROM missing_projection projection
    CROSS JOIN metrics
    LEFT JOIN LATERAL (
      SELECT gap
      FROM unnest(projection.missing) WITH ORDINALITY AS gaps(gap, ordinal)
      ORDER BY ordinal
      LIMIT ${Math.max(1, Math.trunc(gapLimit))}
    ) reported ON true
  `;

  const first = rows[0];
  if (!first) {
    return {
      nextWindowStart: initial,
      closedBoundary,
      pendingPeriodCount: 0,
      missingRanges: [],
      missingRangeCount: 0,
      gapsTruncated: false,
    };
  }
  if (
    first.projection_granularity != null &&
    first.projection_granularity !== granularity
  ) {
    throw new Error(
      `Automation ${automationId} window projection uses ${first.projection_granularity}, not ${granularity}`
    );
  }

  const missingRanges = rows.flatMap((row) =>
    row.gap_start && row.gap_end
      ? [{ start: new Date(row.gap_start), end: new Date(row.gap_end) }]
      : []
  );
  const missingRangeCount = Number(first.missing_range_count);
  return {
    nextWindowStart: new Date(first.next_window_start),
    closedBoundary,
    pendingPeriodCount: Number(first.pending_period_count),
    missingRanges,
    missingRangeCount,
    gapsTruncated: missingRangeCount > missingRanges.length,
  };
}

/** Read the latest completed non-event period from the bounded write-time projection. */
export async function readLastCompletedWindowStart(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity
): Promise<Date | null> {
  const [projection] = await sql<{
    last_completed_window_start: string | Date | null;
    window_projection_granularity: string | null;
  }>`
    SELECT last_completed_window_start, window_projection_granularity
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
  if (
    !projection?.last_completed_window_start ||
    (projection.window_projection_granularity != null &&
      projection.window_projection_granularity !== granularity)
  ) {
    return null;
  }
  return alignToAutomationWindowStart(
    new Date(projection.last_completed_window_start),
    granularity
  );
}

/**
 * Resolve an agent-supplied `since`/`until` to a UTC instant.
 *
 * Window boundaries are UTC everywhere in this file (`alignToAutomationWindowStart`
 * is all `setUTCHours`), but `parseDateAlias` normalizes every result to midnight
 * in the SERVER's LOCAL zone — and the two disagree by a full day in BOTH
 * directions:
 *
 *   UTC-5  `new Date('2026-08-06')` is UTC midnight = local Aug 5 19:00, so
 *          `.setHours(0,0,0,0)` lands on Aug 5. The agent asked for the 6th and
 *          would have written the 5th.
 *   UTC+3  the same call lands on local Aug 6 = `2026-08-05T21:00Z`, which
 *          `alignToAutomationWindowStart` then snaps back to Aug 5. Same wrong day,
 *          reached by a different route.
 *
 * `get_automation.next_action` hands MCP clients exactly such a `YYYY-MM-DD` string,
 * so the server's own suggested call did not round-trip on any non-UTC
 * deployment. A calendar date is a UTC day here, so parse it as one directly and
 * never let the local zone touch it.
 *
 * Aliases (`today`, `7d`, `last_week`) are relative to the server's clock by
 * definition, so those still go through `parseDateAlias`; only their resulting
 * calendar day is reinterpreted as UTC.
 *
 * Caught by the e2e on a west-of-UTC machine (it asked for 2026-08-06 and got the
 * 2026-08-05 window). Invisible to every unit test, which all pass in UTC.
 */
export function parseAutomationWindowDate(value: string): Date {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T00:00:00.000Z`);
  }
  const local = parseDateAlias(trimmed).date;
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
}

/**
 * When something an Automation window produced actually happened.
 *
 * `window_end` alone is a future instant for the whole day a sub-daily Automation
 * runs — `window-utils` has no 'hourly' granularity — and every read path bounds
 * on `occurred_at <= now()`, so a flat `window_end` stamp hides the row until
 * the window closes. Clamping keeps the period-end reading for a window
 * completed after it closed and tells the truth for one still open.
 *
 * Shared rather than inlined because the stamp has more than one writer:
 * `complete-window.ts` writes run output and `feedback.ts` writes a correction.
 */
export function automationOutputOccurredAt(windowEnd: string | Date): string {
  const endMs = new Date(windowEnd).getTime();
  return new Date(
    Number.isFinite(endMs) ? Math.min(endMs, Date.now()) : Date.now()
  ).toISOString();
}

/**
 * Align an agent-requested `since`/`until` span onto granularity boundaries.
 *
 * Deliberately does NOT clamp to a single period. The backfill affordance
 * depends on being able to ask for a wider span — the unprocessed-ranges
 * formatter suggests whole months to a daily Automation — so the span is
 * preserved and only its edges move.
 *
 * The end is aligned UP to the next period start, making it EXCLUSIVE. The
 * previous semantics ran `until` through `toEndOfDay`, storing an inclusive
 * `23:59:59.999`; that is the second boundary convention `computePendingWindow`
 * documents as the source of prod's zero-length windows, and it disagrees with
 * the `>= start AND < end` filter `executeDataSources` applies. An agent-written
 * window is now indistinguishable in shape from a server-computed one.
 */
export function alignRequestedWindow(
  since: Date,
  until: Date,
  granularity: AutomationTimeGranularity
): { windowStart: Date; windowEnd: Date } {
  const windowStart = alignToAutomationWindowStart(since, granularity);
  const alignedUntil = alignToAutomationWindowStart(until, granularity);
  // `until` is inclusive as the caller means it ("through June 30"), so the
  // period containing it is part of the span and the exclusive end is the
  // period after that one. A same-period since/until yields exactly one period
  // rather than a zero-length window.
  const windowEnd = addAutomationPeriod(
    alignedUntil < windowStart ? windowStart : alignedUntil,
    granularity
  );
  return { windowStart, windowEnd };
}

/**
 * How the window a run is about to analyse sits against the clock.
 *
 * Two different facts, and conflating them is a bug this function was rewritten
 * to fix. `periodsBehind` measures the WINDOW BEING HANDED OUT, not the latest
 * completed period. A healthy daily Automation normally hands out the period
 * immediately after that completion, so measuring the completion itself would
 * overstate lag by one period.
 *
 * `periodsSkipped` describes a caller-selected window that starts after the
 * latest completed period. Normal sequential dispatch therefore reports zero;
 * older unfinished holes remain in `pending_analysis`, and a later ad-hoc read
 * does not advance that durable oldest-unfinished projection.
 *
 * Deliberately still raw facts: no `is_stale` flag. Whether a skipped span is
 * worth draining depends on what the Automation is FOR — a drafting Automation wants
 * to skip, a metrics one wants every period because the gaps are its data — and
 * that judgment lives in the prompt, which this function will never see.
 */
export function computeWindowLag(
  lastCompletedWindowStart: Date | null,
  windowStart: Date,
  now: Date,
  granularity: AutomationTimeGranularity
): {
  currentPeriodStart: Date;
  periodsBehind: number;
  skippedFrom: Date | null;
  skippedTo: Date | null;
  periodsSkipped: number;
} {
  const currentPeriodStart = alignToAutomationWindowStart(now, granularity);
  const alignedWindow = alignToAutomationWindowStart(windowStart, granularity);
  // Whole periods between the two aligned instants. Arithmetic rather than a
  // loop so a window years adrift costs the same as one a day adrift, and exact
  // because every alignment is UTC — no DST to round over.
  const periodsBehind = Math.max(
    0,
    wholePeriodsBetween(alignedWindow, currentPeriodStart, granularity)
  );

  // The period after the latest completion. A later caller-selected window
  // leaves the intervening range visible without advancing pending_analysis.
  const chained = lastCompletedWindowStart
    ? addAutomationPeriod(
        alignToAutomationWindowStart(lastCompletedWindowStart, granularity),
        granularity
      )
    : null;
  const periodsSkipped =
    chained && chained < alignedWindow
      ? wholePeriodsBetween(chained, alignedWindow, granularity)
      : 0;

  return {
    currentPeriodStart,
    periodsBehind,
    skippedFrom: periodsSkipped > 0 ? chained : null,
    // Inclusive: the last period actually skipped is the one before the window.
    skippedTo:
      periodsSkipped > 0
        ? alignToAutomationWindowStart(
            subtractAutomationPeriod(alignedWindow, granularity),
            granularity
          )
        : null,
    periodsSkipped,
  };
}

/**
 * The lag stated in words, or null when there is nothing to say.
 *
 * This exists because reporting the NUMBER was not enough. Measured 2026-08-06
 * against a live run: an Automation seeded fifty periods behind, handed
 * `periods_behind: 50`, analysed the stale window anyway and advanced the cursor
 * by exactly one period — the prod pathology reproduced WITH the lag field in
 * place. Automation runs reach knowledge through `run_sdk`, which returns JSON, so
 * all the model ever saw was four numbers inside a thirteen-key object. The
 * prose lived in the markdown formatter, on a path Automation runs never take.
 *
 * So the guidance travels WITH the data, on every surface.
 *
 * No threshold. It speaks exactly when a caller explicitly selected a later
 * span; normal sequential recovery reports no skipped periods.
 */
export function describeWindowLag(lag: {
  skippedFrom: Date | null;
  skippedTo: Date | null;
  periodsSkipped: number;
  granularity: AutomationTimeGranularity;
}): string | null {
  if (lag.periodsSkipped < 1 || !lag.skippedFrom || !lag.skippedTo) return null;
  return (
    `${lag.periodsSkipped} ${lag.granularity} period(s) between this Automation's last completed ` +
    `window and the one above are not included here — ${lag.skippedFrom.toISOString()} through ` +
    `${lag.skippedTo.toISOString()}. The sequential Automation cursor remains on the oldest ` +
    'missing period; a normal claim will still return it. Read and complete this explicitly ' +
    'selected window without treating the intervening periods as processed.'
  );
}

const MS_PER_DAY = 86_400_000;

function wholePeriodsBetween(
  from: Date,
  to: Date,
  granularity: AutomationTimeGranularity
): number {
  switch (granularity) {
    case 'daily':
      return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
    case 'weekly':
      return Math.round((to.getTime() - from.getTime()) / (MS_PER_DAY * 7));
    case 'monthly':
      return monthsBetween(from, to);
    case 'quarterly':
      return Math.trunc(monthsBetween(from, to) / 3);
  }
}

function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  );
}

/**
 * The period an Automation should analyse next, given the start of its most recent
 * window (or null if it has none).
 *
 * Pure and exported because TWO call sites need it and they must not drift:
 * `computePendingWindow` above, which is what actually dispatches, and
 * `get_automation`'s `next_window`, which only PREVIEWS the dispatch. While those
 * were two implementations they disagreed by a full period on legacy rows —
 * telling the agent one window and handing the run another. One rule, one
 * implementation, no drift.
 *
 * Takes the last window's START, never its end: `window_end` is not reliably an
 * exclusive boundary (agents write windows through `complete_window`, and prod
 * holds both conventions), so chaining off it starts the next period a
 * millisecond short of a full one.
 *
 * `now` is a parameter rather than read here so the rule stays a pure function
 * of its inputs and can be tested at a chosen instant.
 */
export function nextAutomationWindowStart(
  lastWindowStart: Date | null,
  now: Date,
  granularity: AutomationTimeGranularity
): Date {
  const alignedNow = alignToAutomationWindowStart(now, granularity);
  // The oldest window a current Automation is ever handed. Aligned BEFORE the
  // subtraction: `setUTCMonth(month - 1)` on the 29th–31st rolls FORWARD
  // (Feb 31 → Mar 3), so subtracting from a raw `now` handed a monthly Automation
  // run on the 31st the window it was already on.
  const previousPeriod = alignToAutomationWindowStart(
    subtractAutomationPeriod(alignedNow, granularity),
    granularity
  );

  if (!lastWindowStart) {
    // Nothing analysed yet — start one aligned period back.
    return previousPeriod;
  }

  // Next period after the last one, re-aligned so a corrupt stored start cannot
  // propagate.
  const chained = addAutomationPeriod(
    alignToAutomationWindowStart(lastWindowStart, granularity),
    granularity
  );

  // Advance exactly one completed period. Missing windows remain recoverable in
  // order; the clock never causes the cursor to jump over them.
  // Capped at the current period: being "done" with today means today gets
  // re-analysed (and superseded), not that tomorrow starts — granularity has no
  // 'hourly', so a sub-daily cron must keep resolving to the same day.
  return chained > alignedNow ? alignedNow : chained;
}

/**
 * Build the SELECT clause for automation windows queries.
 *
 * This is used by the get_automation tool for both the main query and fallback granularity queries.
 * Extracts common SQL to avoid duplication.
 *
 * @returns SQL SELECT ... FROM ... JOIN fragment (without WHERE clause)
 */
/**
 * Results read directly from completed Automation runs.
 */
/** FROM fragment for callers that need `iw` joined to versions (the SELECT clause). */
export function buildWindowsFromWithVersions(): string {
  return `runs iw
    JOIN automations i ON iw.automation_id = i.id
    LEFT JOIN automation_versions automation_v ON i.current_version_id = automation_v.id
    LEFT JOIN automation_versions window_v
      ON window_v.id = CASE
        WHEN iw.approved_input->>'version_id' ~ '^\\d+$'
          THEN (iw.approved_input->>'version_id')::bigint
        ELSE NULL
      END`;
}

/** Bare FROM fragment for the COUNT(*) pagination fallback (no version joins). */
export function buildWindowsCountFromClause(): string {
  return `runs iw
    JOIN automations i ON iw.automation_id = i.id`;
}

export function buildWindowsSelectClause(): string {
  return `
    SELECT
      iw.id as run_id,
      iw.automation_id,
      COALESCE(window_v.name, automation_v.name, i.name) as automation_name,
      iw.approved_input->>'granularity' as granularity,
      (iw.approved_input->>'window_start')::timestamptz as window_start,
      (iw.approved_input->>'window_end')::timestamptz as window_end,
      COALESCE(
        CASE WHEN iw.run_metadata->>'content_analyzed' ~ '^\\d+$'
          THEN (iw.run_metadata->>'content_analyzed')::bigint END,
        (SELECT COUNT(*) FROM automation_run_events link WHERE link.run_id = iw.id)
      ) as content_analyzed,
      iw.action_output as extracted_data,
      iw.model_used,
      NULLIF(iw.run_metadata->>'client_id', '') as client_id,
      iw.run_metadata,
      COALESCE(
        CASE WHEN iw.run_metadata->>'execution_time_ms' ~ '^\\d+$'
          THEN (iw.run_metadata->>'execution_time_ms')::bigint END,
        CASE WHEN iw.completed_at IS NOT NULL AND iw.claimed_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (iw.completed_at - iw.claimed_at)) * 1000)::bigint END
      ) as execution_time_ms,
      iw.created_at,
      window_v.id as version_id,
      CAST(COUNT(*) OVER () AS INTEGER) as total_count
    FROM ${buildWindowsFromWithVersions()}
  `.trim();
}

/**
 * Safely convert a value to a JavaScript number.
 *
 * PostgreSQL BIGSERIAL columns can return BigInt,
 * which causes issues with JSON serialization and API responses.
 * This utility ensures consistent number types throughout the application.
 */
export function ensureNumber(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return value;
}

/**
 * Safely convert a timestamp value from a SQL row to an ISO string.
 *
 * postgres.js returns `timestamp`/`timestamptz` columns as JS `Date` objects
 * (not strings) unless the projection casts them to text, so a field typed
 * `string` in the row interface is a `Date` at runtime. Emitting that raw Date
 * as `structuredContent` fails a `Type.String()` outputSchema check. Normalize
 * Date | string to ISO here; `fallback` covers a nullable column (e.g. a window
 * `created_at` that defaults to its `window_end`). Returns null when neither is
 * a usable timestamp — callers map that to a nullable schema field.
 */
export function ensureIsoString(
  value: Date | string | null | undefined,
  fallback?: Date | string | null | undefined
): string | null {
  for (const candidate of [value, fallback]) {
    if (candidate == null) continue;
    const date = candidate instanceof Date ? candidate : new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/**
 * Parse a PostgreSQL bigint[] column that may come back as a raw string
 * like "{9}" or "{1,2,3}" when fetch_types is disabled.
 * Returns an array of numbers.
 */
export function parseBigintArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    return value.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
  }
  return [];
}
