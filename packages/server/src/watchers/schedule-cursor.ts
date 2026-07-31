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
 * watchers (manual-only) are no-ops.
 *
 * Errors are split by whether a retry could ever succeed, because the callers
 * are terminal state transitions inside a transaction:
 *
 * - **Database errors propagate.** They are transient, so the caller SHOULD roll
 *   back its run-failure/completion and let the next tick retry.
 * - **An unparseable cron/timezone does NOT propagate.** It is permanent, so
 *   throwing would roll the caller back forever. Worse, `dispatchWatcherRun`
 *   calls `failWatcherRun` from inside its own `catch`, and
 *   `dispatchPendingWatcherRuns` has no per-run guard — a throw there escapes
 *   both and aborts the dispatch tick for EVERY org, permanently, since the
 *   rolled-back run is re-claimed next tick. Park the Behavior instead: NULL
 *   drops out of the `next_run_at <= now()` due predicate, so it stops
 *   re-selecting until someone fixes the schedule.
 */
export async function advanceWatcherSchedule(
	sql: DbClient,
	watcherId: number | null | undefined
): Promise<void> {
	if (watcherId == null) return;
	const rows = await sql`
    SELECT schedule, timezone
    FROM watchers
    WHERE id = ${watcherId}
    LIMIT 1
  `;
	const schedule = (rows[0]?.schedule as string | null) ?? null;
	const timezone = (rows[0]?.timezone as string | null) ?? null;
	if (!schedule) return;

	// `nextRunAt` returns an ISO string, not a Date.
	let nextTick: string;
	try {
		nextTick = nextRunAt(schedule, new Date(), timezone);
	} catch (error) {
		logger.error(
			{ error, watcherId, schedule, timezone },
			"[watchers] Behavior schedule is unparseable — parking it (next_run_at = NULL). " +
				"It will not run again until the schedule or timezone is corrected."
		);
		await sql`
      UPDATE watchers
      SET next_run_at = NULL,
          updated_at = NOW()
      WHERE id = ${watcherId}
    `;
		return;
	}

	await sql`
    UPDATE watchers
    SET next_run_at = ${nextTick}::timestamptz,
        updated_at = NOW()
    WHERE id = ${watcherId}
  `;
}

/**
 * Advance after terminal failure unless the run came from an event. Event
 * delivery is independent of the cron cursor, so advancing it would skip the
 * next scheduled activation. Call inside the failure transaction.
 *
 * Shared deliberately: three paths mark a Behavior run failed — agent dispatch
 * (`failWatcherRun`), turn resolution (`resolveWatcherRunsByMessageIds`), and
 * the device-CLI `/complete-behavior` endpoint. Written out three times the
 * carve-out drifts, and a diff-scoped reviewer only ever sees one copy. Keep it
 * here rather than re-inlining.
 */
export async function advanceScheduleAfterTerminalFailure(
	sql: DbClient,
	watcherId: number | null | undefined,
	dispatchSource: string | null | undefined
): Promise<void> {
	if (dispatchSource === "event") return;
	await advanceWatcherSchedule(sql, watcherId);
}
