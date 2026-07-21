/**
 * Computed scheduling-health derivation for behaviors (item 3, #2033).
 *
 * The behavior reaper (watchers/automation.ts) already times out stuck pending
 * runs and self-heals `next_run_at`, but nothing SURFACED that a behavior was
 * unhealthy: get_behavior / list returned `next_run_at` / run status raw and
 * the caller had to eyeball it. This helper turns those already-selected fields
 * into a single `health` verdict + a `last_scheduling_error` so the API and UI
 * can flag a behavior that has silently stopped firing.
 *
 * Pure + input-only: every field it reads is already selected by both
 * get_behavior.ts and manage_behaviors/list.ts, so no migration and no extra
 * query — this is a projection, kept in one place so both call sites agree.
 */

import { intervals } from '../config/intervals';

export type BehaviorHealthStatus = 'healthy' | 'degraded';

/**
 * Grace past `next_run_at` before an active behavior is judged as having
 * missed a firing. The behavior scheduler (reconcileWatcherRuns) runs on a
 * 5-minute cron, so a behavior legitimately sits up to one 5-minute cron
 * period past its `next_run_at` between ticks. We add a 60s buffer on top so a
 * behavior mid-dispatch (or a tick that just barely slipped) is never
 * false-flagged. Overridable for tests/operators.
 */
function missedFiringMarginMs(): number {
  const raw = Number(process.env.BEHAVIOR_HEALTH_MISSED_FIRING_MARGIN_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 6 * 60 * 1000;
}

/** Parse a simple `<n> <unit>` Postgres interval literal to milliseconds.
 *  Only the units the interval config emits are handled; anything else falls
 *  back to 2h (the WATCHER_RUN_STALE_INTERVAL default). */
function pgIntervalToMs(literal: string): number {
  const match = /^(\d+)\s+(second|minute|hour|day)s?$/.exec(literal.trim());
  if (!match) return 2 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
  };
  return n * (unitMs[match[2]] ?? 60 * 60 * 1000);
}

/** The latest run status transitions that mean "in flight" (not terminal). */
const IN_FLIGHT_RUN_STATUSES = new Set(['claimed', 'running']);

/**
 * Terminal latest-run statuses that mean the behavior's most recent execution
 * did not succeed. A behavior whose latest run ended in one of these is
 * degraded even when its scheduler cursor is fine — the automation ran and
 * broke (e.g. "No model is configured", context-window overflow), which is
 * exactly the state a caller needs surfaced. Previously health considered only
 * the scheduler cursor, so a behavior could report `healthy` alongside a
 * `failed` latest run (#2033 follow-up).
 */
const FAILED_RUN_STATUSES = new Set(['failed', 'timeout']);

export interface BehaviorHealthInput {
  /** Behavior `status` (only `active` behaviors can be degraded). */
  status: string | null | undefined;
  /** `watchers.next_run_at` — the scheduler cursor. */
  nextRunAt: string | Date | null | undefined;
  /** Latest run status (from buildLatestWatcherRunJoinSql). */
  latestRunStatus?: string | null;
  /** Latest run `created_at`, used to age a stuck pending run. */
  latestRunCreatedAt?: string | Date | null;
  /** Latest run `error_message`, surfaced as `last_scheduling_error`. */
  latestRunError?: string | null;
}

export interface BehaviorHealth {
  health: BehaviorHealthStatus;
  /** Human-readable reasons the behavior is degraded (empty when healthy). */
  reasons: string[];
  /** Latest run error, echoed for convenience (null when none). */
  last_scheduling_error: string | null;
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Derive a behavior's scheduling health from already-selected fields.
 *
 * `degraded` when the behavior is `active` AND any of:
 *   - its latest run ended in a terminal failure (`failed`/`timeout`) — the
 *     automation ran and broke, regardless of the scheduler cursor; or
 *   - its `next_run_at` is in the past by more than the missed-firing margin
 *     (a missed firing), UNLESS a run is currently in flight (claimed/running)
 *     — an active dispatch is healthy, we don't false-degrade mid-tick; or
 *   - its latest run is `pending` and older than the run stale interval
 *     (WATCHER_RUN_STALE_INTERVAL) — a stuck pending run the reaper hasn't
 *     timed out yet.
 * Otherwise `healthy`.
 */
export function computeBehaviorHealth(
  input: BehaviorHealthInput,
  now: number = Date.now()
): BehaviorHealth {
  const reasons: string[] = [];
  const lastError = input.latestRunError ?? null;

  // Only active behaviors have a scheduling obligation; archived/paused ones
  // are healthy-by-definition (they're intentionally not firing).
  if (input.status !== 'active') {
    return { health: 'healthy', reasons, last_scheduling_error: lastError };
  }

  const runInFlight = IN_FLIGHT_RUN_STATUSES.has(input.latestRunStatus ?? '');

  // Failed latest run: the behavior's most recent execution ended in a
  // terminal failure. This is independent of the scheduler cursor — a behavior
  // can be on-schedule yet its automation broke every time it fired.
  if (FAILED_RUN_STATUSES.has(input.latestRunStatus ?? '')) {
    reasons.push(
      lastError
        ? `latest run ${input.latestRunStatus}: ${lastError}`
        : `latest run ${input.latestRunStatus}`,
    );
  }

  // Missed firing: next_run_at is well in the past and nothing is dispatching.
  const nextRunMs = toMs(input.nextRunAt);
  if (!runInFlight && nextRunMs != null && nextRunMs < now - missedFiringMarginMs()) {
    const overdueMin = Math.round((now - nextRunMs) / 60_000);
    reasons.push(`missed firing: next_run_at overdue by ~${overdueMin} min`);
  }

  // Stuck pending run: latest run is pending past the stale interval (the
  // reaper should have timed it out; if it hasn't, the behavior is wedged).
  if (input.latestRunStatus === 'pending') {
    const runCreatedMs = toMs(input.latestRunCreatedAt);
    const staleMs = pgIntervalToMs(intervals.watcherRunStaleInterval);
    if (runCreatedMs != null && runCreatedMs < now - staleMs) {
      const stuckMin = Math.round((now - runCreatedMs) / 60_000);
      reasons.push(`stuck pending run: pending for ~${stuckMin} min`);
    }
  }

  return {
    health: reasons.length > 0 ? 'degraded' : 'healthy',
    reasons,
    last_scheduling_error: lastError,
  };
}
