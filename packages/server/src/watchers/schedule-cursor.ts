import type { DbClient } from "../db/client";
import { nextRunAt } from "../utils/cron";
import logger from "../utils/logger";

/**
 * Move a watcher's `next_run_at` forward to the next cron tick after now.
 *
 * The target is always `nextRunAt(schedule, now)`, so repeated completions
 * within a cron interval converge to the same upcoming tick.
 * (Basing it on `max(now, next_run_at)` instead compounded the schedule: each
 * manual trigger's completion pushed an already-future `next_run_at` one more
 * tick out, so N manual runs silently skipped N cron slots.)
 *
 * Pass either the singleton `sql` client or a transaction handle from
 * `sql.begin(...)` to advance inside the caller's transaction. Schedule-less
 * watchers (manual-only) are no-ops. Database and cron errors propagate so a
 * caller can roll back any related durable state transition.
 */
export async function advanceWatcherSchedule(
	sql: DbClient,
	watcherId: number | null | undefined
): Promise<void> {
	if (watcherId == null) return;
	try {
		const rows = await sql`
      SELECT schedule, timezone
      FROM watchers
      WHERE id = ${watcherId}
      LIMIT 1
    `;
		const schedule = (rows[0]?.schedule as string | null) ?? null;
		const timezone = (rows[0]?.timezone as string | null) ?? null;
		if (!schedule) return;
		await sql`
      UPDATE watchers
      SET next_run_at = ${nextRunAt(schedule, new Date(), timezone)}::timestamptz,
          updated_at = NOW()
      WHERE id = ${watcherId}
    `;
	} catch (error) {
		logger.error(
			{ error, watcherId },
			"[watchers] Failed to advance Behavior schedule"
		);
		throw error;
	}
}
