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
   * The cursor this window was chained off — `readWindowCursor`'s result, handed
   * back so a caller that also needs to report lag does not re-query for a value
   * this function just read.
   */
  cursor: Date | null;
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
 * Reads the durable oldest-unfinished cursor. Legacy rows lazily derive that
 * cursor from unfinished attempts and holes in completed history; normal reads
 * never fast-forward it from the latest run. Window starts are re-aligned so
 * historical inclusive ends cannot shift or collapse the next logical period.
 */
export async function computePendingWindow(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity
): Promise<WindowDates> {
  const cursor = await readWindowCursor(sql, automationId);
  const windowStart = await readExpectedAutomationWindowStart(
    sql,
    automationId,
    granularity,
    new Date(),
    cursor
  );

  // Always a full period. `windowStart <= alignedNow` by construction, so this
  // can never exceed the current period's end and never needs clamping — which
  // is what keeps it from degenerating.
  const windowEnd = addAutomationPeriod(windowStart, granularity);

  return { windowStart, windowEnd, cursor };
}

async function oldestRecoverableAttemptStart(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity
): Promise<Date | null> {
  const [attempt] = await sql<{ window_start: string | Date }>`
    SELECT failed.approved_input->>'window_start' AS window_start
    FROM runs failed
    WHERE failed.automation_id = ${automationId}
      AND failed.run_type = 'automation'
      AND failed.status IN ('failed', 'timeout', 'cancelled')
      AND COALESCE(failed.approved_input->>'dispatch_source', 'scheduled') <> 'event'
      AND failed.approved_input->>'window_start' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM runs completed
        WHERE completed.automation_id = failed.automation_id
          AND completed.run_type = 'automation'
          AND completed.status = 'completed'
          AND completed.action_output IS NOT NULL
          AND (completed.approved_input->>'window_start')::timestamptz =
              (failed.approved_input->>'window_start')::timestamptz
      )
    ORDER BY (failed.approved_input->>'window_start')::timestamptz ASC
    LIMIT 1
  `;
  return attempt?.window_start
    ? alignToAutomationWindowStart(new Date(attempt.window_start), granularity)
    : null;
}

/**
 * Find the first hole in legacy successful windows.
 *
 * This query only runs while the durable cursor is NULL; the claim path writes
 * its answer under the Automation row lock, so normal requests never aggregate
 * run history. It recovers an older hole hidden by out-of-order legacy results.
 */
async function oldestMissingAfterCompletedStart(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity
): Promise<Date | null> {
  const datePart =
    granularity === 'daily'
      ? 'day'
      : granularity === 'weekly'
        ? 'week'
        : granularity === 'monthly'
          ? 'month'
          : 'quarter';
  const interval =
    granularity === 'daily'
      ? '1 day'
      : granularity === 'weekly'
        ? '1 week'
        : granularity === 'monthly'
          ? '1 month'
          : '3 months';
  const [missing] = await sql<{ window_start: string | Date }>`
    WITH completed_periods AS (
      SELECT DATE_TRUNC(
        ${datePart},
        (approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC'
      ) AT TIME ZONE 'UTC' AS window_start
      FROM runs
      WHERE automation_id = ${automationId}
        AND run_type = 'automation'
        AND status = 'completed'
        AND action_output IS NOT NULL
        AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
        AND approved_input->>'window_start' IS NOT NULL
    )
    SELECT completed.window_start + ${interval}::interval AS window_start
    FROM completed_periods completed
    WHERE NOT EXISTS (
      SELECT 1 FROM completed_periods successor
      WHERE successor.window_start = completed.window_start + ${interval}::interval
    )
    ORDER BY completed.window_start ASC
    LIMIT 1
  `;
  return missing?.window_start
    ? alignToAutomationWindowStart(new Date(missing.window_start), granularity)
    : null;
}

async function resolveLegacyExpectedAutomationWindowStart(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity,
  now: Date,
  knownCursor?: Date | null
): Promise<Date> {
  const cursor = knownCursor === undefined
    ? await readWindowCursor(sql, automationId)
    : knownCursor;
  const recoverableAttempt = await oldestRecoverableAttemptStart(sql, automationId, granularity);
  const missingAfterCompleted = cursor
    ? await oldestMissingAfterCompletedStart(sql, automationId, granularity)
    : null;
  const alignedNow = alignToAutomationWindowStart(now, granularity);
  const candidates = [
    recoverableAttempt,
    missingAfterCompleted,
    nextAutomationWindowStart(cursor, now, granularity),
  ]
    .filter((candidate): candidate is Date => candidate != null)
    .map((candidate) => (candidate > alignedNow ? alignedNow : candidate));
  return candidates.reduce((oldest, candidate) => (candidate < oldest ? candidate : oldest));
}

/** Read the durable expected period, including lazy-migration fallback state. */
export async function readExpectedAutomationWindowStart(
  sql: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity,
  now: Date = new Date(),
  knownCursor?: Date | null
): Promise<Date> {
  const [automation] = await sql<{ next_window_start: string | Date | null }>`
    SELECT next_window_start FROM automations WHERE id = ${automationId} LIMIT 1
  `;
  if (automation?.next_window_start) {
    return alignToAutomationWindowStart(new Date(automation.next_window_start), granularity);
  }
  return resolveLegacyExpectedAutomationWindowStart(
    sql,
    automationId,
    granularity,
    now,
    knownCursor
  );
}

/** Lock and lazily persist the oldest unfinished Automation period. */
export async function ensureExpectedAutomationWindowStart(
  tx: DbClient,
  automationId: number,
  granularity: AutomationTimeGranularity,
  now: Date = new Date()
): Promise<Date> {
  const [automation] = await tx<{ next_window_start: string | Date | null }>`
    SELECT next_window_start FROM automations WHERE id = ${automationId} FOR UPDATE
  `;
  if (!automation) throw new Error(`Automation ${automationId} not found`);
  if (automation.next_window_start) {
    return alignToAutomationWindowStart(new Date(automation.next_window_start), granularity);
  }
  const expected = await resolveLegacyExpectedAutomationWindowStart(
    tx,
    automationId,
    granularity,
    now
  );
  await tx`
    UPDATE automations SET next_window_start = ${expected.toISOString()}::timestamptz
    WHERE id = ${automationId} AND next_window_start IS NULL
  `;
  return expected;
}

export async function advanceExpectedAutomationWindow(
  tx: DbClient,
  automationId: number,
  completedWindowStart: Date,
  granularity: AutomationTimeGranularity,
  now: Date = new Date()
): Promise<boolean> {
  const expected = await ensureExpectedAutomationWindowStart(tx, automationId, granularity, now);
  if (
    expected.getTime() !==
    alignToAutomationWindowStart(completedWindowStart, granularity).getTime()
  ) {
    return false;
  }
  const next = nextAutomationWindowStart(expected, now, granularity);
  const updated = await tx`
    UPDATE automations
    SET next_window_start = ${next.toISOString()}::timestamptz,
        updated_at = current_timestamp
    WHERE id = ${automationId}
      AND next_window_start = ${expected.toISOString()}::timestamptz
  `;
  return Number(updated.count ?? 0) === 1;
}

export function countExpectedCompletedAutomationWindows(
  expectedStart: Date,
  now: Date,
  granularity: AutomationTimeGranularity
): number {
  return Math.max(
    0,
    wholePeriodsBetween(
      alignToAutomationWindowStart(expectedStart, granularity),
      alignToAutomationWindowStart(now, granularity),
      granularity
    )
  );
}

/**
 * The Automation's scheduled cursor: the start of its latest completed result period.
 *
 * Completed Automation runs make this a bounded per-Automation lookup. Ordered
 * by `window_start` because that is
 * the field being chained; ordering by `window_end` would re-introduce the
 * boundary ambiguity documented on `computePendingWindow`. Zero-content windows
 * count as durable cursor progress too, otherwise empty periods get reprocessed
 * forever.
 *
 * Event-triggered point runs do not cover a scheduled period and are excluded.
 * Shared by `computePendingWindow` (which advances it) and the lag reported to
 * the agent (which describes it), so the two can never disagree about where the
 * cursor is.
 */
export async function readWindowCursor(
  sql: DbClient,
  automationId: number
): Promise<Date | null> {
  const rows = await sql`
    SELECT (approved_input->>'window_start')::timestamptz AS window_start
    FROM runs
    WHERE automation_id = ${automationId}
      AND run_type = 'automation'
      AND status = 'completed'
      AND action_output IS NOT NULL
      AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
      AND approved_input->>'window_start' IS NOT NULL
    ORDER BY (approved_input->>'window_start')::timestamptz DESC NULLS LAST
    LIMIT 1
  `;
  return rows.length > 0 ? new Date(rows[0].window_start as string) : null;
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
 * to fix. `periodsBehind` measures the WINDOW BEING HANDED OUT, not the cursor.
 * Measured against the cursor, a perfectly healthy daily Automation reads as two
 * periods behind at the moment its run calls `read_knowledge` — the cursor is the
 * period completed by the PREVIOUS run, and the pending window is the one after
 * that. Prod Automation 79 (`0 4 * * *`) sits exactly there every single day. Any
 * staleness threshold applied to the cursor therefore fires on healthy runs.
 *
 * `periodsSkipped` describes a caller-selected window that starts after the
 * sequential cursor. Normal dispatch always chains directly and therefore
 * reports zero; the durable expected cursor is not advanced by a later ad-hoc read.
 *
 * Deliberately still raw facts: no `is_stale` flag. Whether a skipped span is
 * worth draining depends on what the Automation is FOR — a drafting Automation wants
 * to skip, a metrics one wants every period because the gaps are its data — and
 * that judgment lives in the prompt, which this function will never see.
 */
export function computeWindowLag(
  cursor: Date | null,
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

  // The period a sequential claim would cover. A later caller-selected window
  // leaves the intervening range visible here without advancing the cursor.
  const chained = cursor
    ? addAutomationPeriod(alignToAutomationWindowStart(cursor, granularity), granularity)
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
