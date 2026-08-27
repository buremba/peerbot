import type { DbClient } from "../db/client";

const DEFAULT_PAUSE_AFTER_CONSECUTIVE_FAILURES = 5;

function scheduledFailurePauseThreshold(): number {
	const raw = process.env.AUTOMATION_PAUSE_AFTER_CONSECUTIVE_FAILURES;
	if (raw === undefined) return DEFAULT_PAUSE_AFTER_CONSECUTIVE_FAILURES;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_PAUSE_AFTER_CONSECUTIVE_FAILURES;
}

function isScheduledDispatch(
	dispatchSource: string | null | undefined,
): boolean {
	// Older scheduled runs predate the explicit dispatch_source stamp. Manual
	// and event runs have always carried their source when they need different
	// cursor semantics, so NULL remains the backwards-compatible schedule lane.
	return dispatchSource == null || dispatchSource === "scheduled";
}

/**
 * Count one terminal failure from a real, executed scheduled Automation run.
 *
 * The UPDATE is the counter lock: concurrent distinct failures serialize on
 * the Automation row, while a duplicate terminal report never reaches this
 * helper because every caller first wins a status-guarded run transition.
 * Once the threshold winner stamps the pause, later in-flight failures leave
 * both the stable count and pause timestamp untouched.
 */
export async function recordScheduledExecutionFailure(
	sql: DbClient,
	automationId: number | null | undefined,
	dispatchSource: string | null | undefined,
): Promise<void> {
	if (automationId == null || !isScheduledDispatch(dispatchSource)) {
		return;
	}

	const threshold = scheduledFailurePauseThreshold();
	await sql`
    UPDATE automations
    SET consecutive_scheduled_failures = consecutive_scheduled_failures + 1,
        schedule_auto_paused_at = CASE
          WHEN consecutive_scheduled_failures + 1 >= ${threshold}
            THEN date_trunc('milliseconds', current_timestamp)
          ELSE NULL
        END,
        next_run_at = CASE
          WHEN consecutive_scheduled_failures + 1 >= ${threshold}
            THEN NULL
          ELSE next_run_at
        END,
        updated_at = current_timestamp
    WHERE id = ${automationId}
      AND status = 'active'
      AND schedule IS NOT NULL
      AND schedule_auto_paused_at IS NULL
  `;
}

/** Clear the circuit breaker after a successful non-event window. */
export async function resetScheduledFailureState(
	sql: DbClient,
	automationId: number,
): Promise<void> {
	await sql`
    UPDATE automations
    SET consecutive_scheduled_failures = 0,
        schedule_auto_paused_at = NULL
    WHERE id = ${automationId}
      AND (
        consecutive_scheduled_failures <> 0
        OR schedule_auto_paused_at IS NOT NULL
      )
  `;
}
