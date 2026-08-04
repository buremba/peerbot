import { AgentErrorCode } from "@lobu/core";
import type { DbClient } from "../db/client";
import { nextRunAt } from "../utils/cron";
import logger from "../utils/logger";

const PROVIDER_RESET_GRACE_MS = 60_000;

/**
 * Extract the reset timestamp from provider quota errors such as:
 *
 * - "Your limit will reset at 2026-07-31"
 * - "Your limit will reset at 2026-07-10 04:32:47"
 *
 * Providers frequently omit a timezone. Treat an omitted zone as UTC rather
 * than the gateway host's local time so replicas in different regions agree.
 * The one-minute grace avoids retrying at the exact reset boundary.
 */
export function parseProviderQuotaResetAt(
	message: string,
	now: Date = new Date()
): Date | null {
	const match = message.match(
		/\breset(?:s)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?(?![ T]\d{2}:)(?![0-9A-Za-z:+-]|\.\d)/i
	);
	if (!match) return null;

	const [, date, hour, minute, second, milliseconds, rawZone] = match;
	const [yearText, monthText, dayText] = date.split("-");
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hourValue = Number(hour ?? "0");
	const minuteValue = Number(minute ?? "0");
	const secondValue = Number(second ?? "0");
	const daysInMonth = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		daysInMonth === undefined ||
		day > daysInMonth ||
		hourValue < 0 ||
		hourValue > 23 ||
		minuteValue < 0 ||
		minuteValue > 59 ||
		secondValue < 0 ||
		secondValue > 59
	) {
		return null;
	}

	const normalizedZone = rawZone?.toUpperCase();
	if (normalizedZone && normalizedZone !== "Z") {
		const offsetHour = Number(normalizedZone.slice(1, 3));
		const offsetMinute = Number(normalizedZone.slice(-2));
		if (offsetHour > 23 || offsetMinute > 59) {
			return null;
		}
	}
	const zone = normalizedZone
		? normalizedZone === "Z" || normalizedZone.includes(":")
			? normalizedZone
			: `${normalizedZone.slice(0, 3)}:${normalizedZone.slice(3)}`
		: "Z";
	const timestamp =
		`${date}T${hour ?? "00"}:${minute ?? "00"}:${second ?? "00"}.` +
		`${milliseconds?.padEnd(3, "0") ?? "000"}${zone}`;
	const parsed = new Date(timestamp);
	const notBeforeMs = parsed.getTime() + PROVIDER_RESET_GRACE_MS;
	if (
		!Number.isFinite(parsed.getTime()) ||
		notBeforeMs <= now.getTime()
	) {
		return null;
	}
	return new Date(notBeforeMs);
}

/**
 * Resolve a provider reset boundary for a terminal error.
 *
 * Structured worker/API paths must explicitly classify the error as quota
 * exhaustion; this prevents an unrelated provider sentence containing
 * "reset at" from moving a schedule.
 */
export function providerQuotaResetNotBefore(
	message: string,
	errorCode?: string,
	now: Date = new Date()
): Date | null {
	if (errorCode !== AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED) {
		return null;
	}
	return parseProviderQuotaResetAt(message, now);
}

/**
 * Device CLI reports do not carry a structured error code, so require both an
 * explicit reset timestamp and provider-quota wording before moving a durable
 * schedule. This prevents unrelated stderr such as "session resets at ..."
 * from parking a Behavior.
 */
export function deviceProviderQuotaResetNotBefore(
	message: string,
	now: Date = new Date()
): Date | null {
	const hasQuotaEvidence =
		/credit balance is too low|insufficient (?:credits?|balance|funds|quota)\b|billing_hard_limit_reached|payment required|exceeded your current quota|out of credits?\b|weekly\/monthly limit exhausted|limit exhausted|rate[-\s]?limit|quota (?:exceeded|exhausted)|too many requests|\b429\b|resource_exhausted/i.test(
			message
		);
	return hasQuotaEvidence ? parseProviderQuotaResetAt(message, now) : null;
}

/**
 * Move a watcher's `next_run_at` forward without shortening its current park.
 *
 * The target is `nextRunAt(schedule, now)` unless the caller supplies a later
 * `notBefore` boundary. The write never moves an existing cursor backward, so
 * overlapping completions cannot erase a quota park.
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
	watcherId: number | null | undefined,
	notBefore?: Date | null
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

	const notBeforeMs = notBefore?.getTime();
	const target =
		typeof notBeforeMs === "number" &&
		Number.isFinite(notBeforeMs) &&
		notBeforeMs > new Date(nextTick).getTime()
			? new Date(notBeforeMs).toISOString()
			: nextTick;

	await sql`
    UPDATE watchers
    SET next_run_at = GREATEST(next_run_at, ${target}::timestamptz),
        updated_at = NOW()
    WHERE id = ${watcherId}
  `;
}

/**
 * Advance after terminal failure unless the run came from an event with no
 * explicit retry boundary. Ordinary event delivery is independent of the cron
 * cursor, but a provider quota boundary must park any scheduled activation too.
 * Call inside the caller's terminal-state transaction. Run-backed failures and
 * reply-to-source turns share this policy so their event carve-out cannot drift.
 */
export async function advanceScheduleAfterTerminalFailure(
	sql: DbClient,
	watcherId: number | null | undefined,
	dispatchSource: string | null | undefined,
	notBefore?: Date | null
): Promise<void> {
	if (dispatchSource === "event" && notBefore == null) return;
	await advanceWatcherSchedule(sql, watcherId, notBefore);
}
