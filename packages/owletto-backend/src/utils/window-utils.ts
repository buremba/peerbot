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
} from '@lobu/owletto-sdk';
import type { DbClient } from '../db/client';

interface WindowDates {
  windowStart: Date;
  windowEnd: Date;
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
  // Find the last completed leaf window for this watcher. Zero-content
  // windows are durable cursor progress too; otherwise empty periods can be
  // reprocessed forever.
  const lastWindow = await sql`
    SELECT window_end
    FROM watcher_windows
    WHERE watcher_id = ${watcherId}
      AND COALESCE(is_rollup, false) = false
    ORDER BY window_end DESC
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
export function buildWindowsSelectClause(): string {
  return `
    SELECT
      iw.id as window_id,
      iw.watcher_id,
      COALESCE(window_v.name, watcher_v.name, i.name) as watcher_name,
      iw.granularity,
      iw.window_start,
      iw.window_end,
      iw.is_rollup,
      iw.depth,
      iw.source_window_ids,
      iw.content_analyzed,
      iw.extracted_data,
      iw.model_used,
      iw.client_id,
      iw.run_metadata,
      iw.execution_time_ms,
      iw.created_at,
      iw.version_id,
      COALESCE(window_v.json_template, watcher_v.json_template) as json_template
    FROM watcher_windows iw
    JOIN watchers i ON iw.watcher_id = i.id
    LEFT JOIN watcher_versions watcher_v ON i.current_version_id = watcher_v.id
    LEFT JOIN watcher_versions window_v ON iw.version_id = window_v.id
  `.trim();
}

/**
 * Query uncondensed leaf windows for a watcher.
 * These are depth=0 windows not referenced in any rollup's source_window_ids.
 */
export async function queryUncondensedWindows(
  sql: DbClient,
  watcherId: number | string
): Promise<
  Array<{
    id: number;
    window_start: string;
    window_end: string;
    extracted_data: unknown;
    content_analyzed: number;
  }>
> {
  const rows = await sql`
    SELECT ww.id, ww.window_start, ww.window_end, ww.extracted_data, ww.content_analyzed
    FROM watcher_windows ww
    WHERE ww.watcher_id = ${watcherId} AND ww.depth = 0
      AND NOT EXISTS (
        SELECT 1 FROM watcher_windows rw
        WHERE rw.is_rollup = true AND rw.watcher_id = ${watcherId}
          AND ww.id = ANY(rw.source_window_ids)
      )
    ORDER BY ww.window_start
  `;
  return rows.map((r: any) => ({
    id: Number(r.id),
    window_start: r.window_start as string,
    window_end: r.window_end as string,
    extracted_data: r.extracted_data,
    content_analyzed: Number(r.content_analyzed),
  }));
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
