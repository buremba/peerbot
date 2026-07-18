/**
 * Cron scheduling utilities shared by feed and watcher schedulers.
 *
 * Collected feeds with schedule = NULL are manual-only (trigger_feed). There is
 * no platform default cadence — callers that want a poll must pass an explicit
 * cron (e.g. app-install AUTO_FEED_SCHEDULE).
 */

import { CronExpressionParser } from 'cron-parser';

const MIN_INTERVAL_MS = 60_000; // 1 minute minimum between runs

/**
 * Compute the next run time from a cron expression.
 * Returns an ISO string suitable for storing in `next_run_at`.
 *
 * `tz` is an IANA zone name; when set, wall-clock fields in the expression
 * ("0 9 * * *") are evaluated in that zone, DST included. When omitted the
 * expression is evaluated in server time (UTC in prod).
 */
export function nextRunAt(schedule: string, from: Date = new Date(), tz?: string | null): string {
  const interval = CronExpressionParser.parse(schedule, { currentDate: from, tz: tz ?? undefined });
  return interval.next().toDate().toISOString();
}

/**
 * Validate an IANA timezone name. Returns null if valid, error message if not.
 */
export function validateTimezone(tz: string): string | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return null;
  } catch {
    return `Unknown IANA timezone: ${tz}`;
  }
}

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
export function validateSchedule(schedule: string): string | null {
  try {
    const interval = CronExpressionParser.parse(schedule);
    // Check minimum interval (at least 1 minute apart)
    const first = interval.next().toDate();
    const second = interval.next().toDate();
    const intervalMs = second.getTime() - first.getTime();
    if (intervalMs < MIN_INTERVAL_MS) {
      return `Schedule interval too frequent (${Math.round(intervalMs / 1000)}s). Minimum is 1 minute.`;
    }
    return null;
  } catch (e: any) {
    return `Invalid cron expression: ${e.message}`;
  }
}

