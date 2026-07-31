/**
 * Window utilities for watcher time windows
 *
 * Computes pending window dates based on schedule (cron) or granularity label.
 */

import {
  addBehaviorPeriod,
  alignToBehaviorWindowStart,
  subtractBehaviorPeriod,
  type BehaviorTimeGranularity,
} from '@lobu/connector-sdk';
import type { DbClient } from '../db/client';
import type { UnprocessedRange } from '../types/watchers';

interface WindowDates {
  windowStart: Date;
  windowEnd: Date;
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
 * to a watcher's windows per month — into the `UnprocessedRange[]` histogram.
 *
 * Shared by `get_content` (Behavior mode) and `get_behavior` (pending analysis).
 *
 * @param includeComplete when true, months with zero unprocessed content are
 *   still emitted (with `status: 'complete'`). When false, only months with
 *   unprocessed content are emitted. `get_content` passes true; `get_behavior`
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
 * Compute the pending window dates for a watcher.
 *
 * Returns a period-aligned window of exactly one granularity period:
 * `[aligned start, start + 1 period)`. The end is EXCLUSIVE.
 *
 * Chains off the last window's `window_start`, never its `window_end`. Using
 * the end assumes it is an exclusive boundary, and it is not reliably one:
 * windows are written by agents through `complete_window`, and prod holds both
 * conventions in the same table (measured 2026-07-31 — daily: 29 rows ending
 * `23:59:59.999` vs 32 ending `00:00:00`; weekly: 28 vs 2). Chaining off an
 * inclusive end starts the next window a day-minus-a-millisecond early, which
 * then (a) collapses to a ZERO-length window once clamped — five such windows
 * exist on prod, every one with `content_analyzed = 0` — and (b) never matches
 * a fresh period in `findCanvasHead`, so no new chain root is created, so this
 * function keeps returning the same window forever (Behavior 71 spent a full
 * day re-completing the previous day's window).
 *
 * Re-aligning the stored start also makes the 14 already-misaligned prod rows
 * self-heal on their next run, with no migration rewriting window identities.
 *
 * The period never runs ahead of the clock: `BEHAVIOR_TIME_GRANULARITIES` has
 * no 'hourly', so an hourly cron necessarily gets a DAILY window and every run
 * inside a day must resolve to that SAME day for `replace_existing` to refresh
 * it. Advancing unconditionally would mint tomorrow's window at 00:01 and march
 * into the future. Hence the clamp to the current period rather than a cap on
 * the end — a clamped END is what produced the zero-length windows.
 */
export async function computePendingWindow(
  sql: DbClient,
  watcherId: number,
  granularity: BehaviorTimeGranularity
): Promise<WindowDates> {
  // Latest period this Behavior has a chain root for (canvas_windows = one row
  // per root). Ordered by window_start because that is the field being chained;
  // ordering by window_end would re-introduce the boundary ambiguity above.
  // Zero-content windows are durable cursor progress too, otherwise empty
  // periods get reprocessed forever.
  const lastWindow = await sql`
    SELECT window_start
    FROM canvas_windows
    WHERE watcher_id = ${watcherId}
    ORDER BY window_start DESC
    LIMIT 1
  `;

  const now = new Date();
  const windowStart = nextBehaviorWindowStart(
    lastWindow.length > 0 ? new Date(lastWindow[0].window_start as string) : null,
    now,
    granularity
  );

  // Always a full period. `windowStart <= alignedNow` by construction, so this
  // can never exceed the current period's end and never needs clamping — which
  // is what keeps it from degenerating.
  const windowEnd = addBehaviorPeriod(windowStart, granularity);

  return { windowStart, windowEnd };
}

/**
 * The period a Behavior should analyse next, given the start of its most recent
 * window (or null if it has none).
 *
 * Pure and exported because TWO call sites need it and they must not drift:
 * `computePendingWindow` above, which is what actually dispatches, and
 * `get_behavior`'s `next_window`, which only PREVIEWS the dispatch. While those
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
export function nextBehaviorWindowStart(
  lastWindowStart: Date | null,
  now: Date,
  granularity: BehaviorTimeGranularity
): Date {
  const alignedNow = alignToBehaviorWindowStart(now, granularity);

  if (!lastWindowStart) {
    // Nothing analysed yet — start one aligned period back.
    return alignToBehaviorWindowStart(subtractBehaviorPeriod(now, granularity), granularity);
  }

  // Next period after the last one, re-aligned so a corrupt stored start cannot
  // propagate. Capped at the current period: being "done" with today means today
  // gets re-analysed (and superseded), not that tomorrow starts — granularity has
  // no 'hourly', so a sub-daily cron must keep resolving to the same day.
  const nextStart = addBehaviorPeriod(
    alignToBehaviorWindowStart(lastWindowStart, granularity),
    granularity
  );
  return nextStart > alignedNow ? alignedNow : nextStart;
}

/**
 * Build the SELECT clause for watcher windows queries.
 *
 * This is used by the get_behavior tool for both the main query and fallback granularity queries.
 * Extracts common SQL to avoid duplication.
 *
 * @returns SQL SELECT ... FROM ... JOIN fragment (without WHERE clause)
 */
/**
 * Windows read from the `canvas_windows` view — one row per canvas chain ROOT,
 * live extracted_data from the chain HEAD, provenance from the head's run (see
 * migration 20260703000000). `iw.id` is the ROOT event id (the window
 * identity), so link tables re-keyed to root ids match.
 */
/** FROM fragment for callers that need `iw` joined to versions (the SELECT clause). */
export function buildWindowsFromWithVersions(): string {
  return `canvas_windows iw
    JOIN watchers i ON iw.watcher_id = i.id
    LEFT JOIN watcher_versions watcher_v ON i.current_version_id = watcher_v.id
    LEFT JOIN watcher_versions window_v ON iw.version_id = window_v.id`;
}

/** Bare FROM fragment for the COUNT(*) pagination fallback (no version joins). */
export function buildWindowsCountFromClause(): string {
  return `canvas_windows iw
    JOIN watchers i ON iw.watcher_id = i.id`;
}

export function buildWindowsSelectClause(): string {
  return `
    SELECT
      iw.id as window_id,
      iw.watcher_id,
      COALESCE(window_v.name, watcher_v.name, i.name) as watcher_name,
      iw.granularity,
      iw.window_start,
      iw.window_end,
      iw.content_analyzed,
      iw.extracted_data as extracted_data,
      iw.model_used,
      iw.client_id,
      iw.run_metadata,
      iw.execution_time_ms,
      iw.created_at,
      iw.version_id,
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
