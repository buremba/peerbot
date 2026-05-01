/**
 * Cron scheduling utilities shared by feed and watcher schedulers.
 */

import { CronExpressionParser } from 'cron-parser';

const DEFAULT_SCHEDULE = '0 */6 * * *'; // every 6 hours
const MIN_INTERVAL_MS = 60_000; // 1 minute minimum between runs

/**
 * Compute the next run time from a cron expression.
 * Returns an ISO string suitable for storing in `next_run_at`.
 */
export function nextRunAt(schedule: string, from: Date = new Date()): string {
  const interval = CronExpressionParser.parse(schedule, { currentDate: from });
  return interval.next().toDate().toISOString();
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

export { DEFAULT_SCHEDULE };
