/**
 * Window utilities for watcher time windows
 *
 * Computes pending window dates based on schedule (cron) or granularity label.
 */

import {
  addWatcherPeriod,
  alignToWatcherWindowStart,
  subtractWatcherPeriod,
  type WatcherTimeGranularity,
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
 * Shared by `get_content` (watcher mode) and `get_watcher` (pending analysis).
 *
 * @param includeComplete when true, months with zero unprocessed content are
 *   still emitted (with `status: 'complete'`). When false, only months with
 *   unprocessed content are emitted. `get_content` passes true; `get_watcher`
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
 * Logic:
 * - Finds the last completed window for this watcher
 * - Computes the next window period based on granularity
 * - If no previous windows, uses "now minus one period" as the start
 */
export async function computePendingWindow(
  sql: DbClient,
  watcherId: number,
  granularity: WatcherTimeGranularity
): Promise<WindowDates> {
  // Find the last completed leaf window for this watcher from the canvas chain
  // HEADs (semantic_type='canvas_state'). Zero-content windows are durable
  // cursor progress too; otherwise empty periods can be reprocessed forever.
  // Scoped to canvas_state so it never matches tab_event/tab_snapshot BROWSER
  // rows that also carry metadata.window_id. Any chain member carries the
  // period's window_end (superseders copy it), so we don't need to isolate the
  // head — MAX over all chain members for this watcher is the last window_end.
  const lastWindow = await sql`
    SELECT (e.metadata->>'window_end')::timestamptz AS window_end
    FROM events e
    WHERE e.semantic_type = 'canvas_state'
      AND (e.metadata->>'watcher_id')::bigint = ${watcherId}
    ORDER BY (e.metadata->>'window_end')::timestamptz DESC
    LIMIT 1
  `;

  const now = new Date();
  let windowStart: Date;
  let windowEnd: Date;

  if (lastWindow.length > 0) {
    // Continue from where the last window ended
    windowStart = new Date(lastWindow[0].window_end as string);
  } else {
    // No previous windows - start from aligned "now minus one period"
    windowStart = alignToWatcherWindowStart(subtractWatcherPeriod(now, granularity), granularity);
  }

  // Compute window end based on granularity
  windowEnd = addWatcherPeriod(windowStart, granularity);

  // Cap window_end at aligned now (don't process future dates)
  const alignedNow = alignToWatcherWindowStart(now, granularity);
  // For current period, use end of period instead of aligned start
  const currentPeriodEnd = addWatcherPeriod(alignedNow, granularity);
  if (windowEnd > currentPeriodEnd) {
    windowEnd = currentPeriodEnd;
  }

  // Ensure window_start is before window_end
  if (windowStart >= windowEnd) {
    // If window is too small, extend back by one period
    windowStart = subtractWatcherPeriod(windowEnd, granularity);
  }

  return { windowStart, windowEnd };
}

/**
 * Build the SELECT clause for watcher windows queries.
 *
 * This is used by the get_watcher tool for both the main query and fallback granularity queries.
 * Extracts common SQL to avoid duplication.
 *
 * @returns SQL SELECT ... FROM ... JOIN fragment (without WHERE clause)
 */
/**
 * Canvas-on-events FROM fragment: a watcher "window" is now the ROOT of a
 * `semantic_type='canvas_state'` supersede chain (supersedes_event_id IS NULL).
 * `iw` is derived from those roots so the get_watcher query bodies keep
 * referencing `iw.watcher_id / iw.granularity / iw.window_start / …` unchanged.
 *
 * A window's live extracted_data lives on the chain HEAD (the member with no
 * superseder); the LATERAL resolves it and its provenance run. window_id is the
 * ROOT event id (the window identity), so link tables re-keyed to root ids match.
 *
 * Scoped to semantic_type='canvas_state' throughout so it never matches
 * tab_event/tab_snapshot BROWSER rows that also carry metadata.window_id. Keys
 * match idx_canvas_chain_root / idx_canvas_state_listing so probes stay on the
 * partial indexes. window_start/window_end are the canonical UTC ISO text in
 * metadata cast to timestamptz (matches the WHERE-clause casts the callers use).
 */
function buildWindowsFromClause(): string {
  return `
    (
      SELECT
        root.id AS id,
        (root.metadata->>'watcher_id')::bigint AS watcher_id,
        root.metadata->>'granularity' AS granularity,
        (root.metadata->>'window_start')::timestamptz AS window_start,
        (root.metadata->>'window_end')::timestamptz AS window_end,
        (root.metadata->>'version_id')::bigint AS version_id,
        root.created_at AS created_at,
        head.payload_data AS extracted_data,
        COALESCE((head.metadata->>'content_analyzed')::int, 0) AS content_analyzed,
        head.client_id AS client_id,
        run.model_used AS model_used,
        run.run_metadata AS run_metadata,
        COALESCE(
          (run.run_metadata->>'execution_time_ms')::int,
          CASE
            WHEN run.completed_at IS NOT NULL AND run.claimed_at IS NOT NULL
              THEN (EXTRACT(EPOCH FROM (run.completed_at - run.claimed_at)) * 1000)::int
            ELSE NULL
          END
        ) AS execution_time_ms
      FROM events root
      LEFT JOIN LATERAL (
        SELECT e.payload_data, e.metadata, e.client_id, e.run_id
        FROM events e
        WHERE e.semantic_type = 'canvas_state'
          AND (e.metadata->>'watcher_id')::bigint = (root.metadata->>'watcher_id')::bigint
          AND (e.metadata->>'granularity') = (root.metadata->>'granularity')
          AND (e.metadata->>'window_start') = (root.metadata->>'window_start')
          AND e.superseded_by IS NULL
        LIMIT 1
      ) head ON TRUE
      LEFT JOIN runs run ON run.id = head.run_id
      WHERE root.semantic_type = 'canvas_state'
        AND root.supersedes_event_id IS NULL
    ) iw
    JOIN watchers i ON iw.watcher_id = i.id`;
}

/** FROM fragment for callers that need `iw` joined to versions (the SELECT clause). */
export function buildWindowsFromWithVersions(): string {
  return `${buildWindowsFromClause()}
    LEFT JOIN watcher_versions watcher_v ON i.current_version_id = watcher_v.id
    LEFT JOIN watcher_versions window_v ON iw.version_id = window_v.id`;
}

/** Bare FROM fragment for the COUNT(*) pagination fallback (no version joins). */
export function buildWindowsCountFromClause(): string {
  return buildWindowsFromClause();
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
