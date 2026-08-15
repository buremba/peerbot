/**
 * Computed health derivation for automations (item 3, #2033).
 *
 * The automation reaper (automations/automation.ts) already times out stuck pending
 * runs and self-heals `next_run_at`, but nothing SURFACED that an automation was
 * unhealthy: get_automation / list returned `next_run_at` / run status raw and
 * the caller had to eyeball it. This helper turns those already-selected fields
 * into a single `health` verdict + a `last_scheduling_error` so the API and UI
 * can flag an automation that stopped firing or whose latest run failed.
 *
 * Pure + input-only: every field it reads is already selected by both
 * get_automation.ts and manage_automations/list.ts, so no migration and no extra
 * query — this is a projection, kept in one place so both call sites agree.
 */

import { intervals } from '../config/intervals';

export type AutomationHealthStatus = 'healthy' | 'degraded';

/**
 * Grace past `next_run_at` before an active automation is judged as having
 * missed a firing. The automation scheduler (reconcileAutomationRuns) runs on a
 * 5-minute cron, so an automation legitimately sits up to one 5-minute cron
 * period past its `next_run_at` between ticks. We add a 60s buffer on top so a
 * automation mid-dispatch (or a tick that just barely slipped) is never
 * false-flagged. Overridable for tests/operators.
 */
function missedFiringMarginMs(): number {
  const raw = Number(process.env.AUTOMATION_HEALTH_MISSED_FIRING_MARGIN_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 6 * 60 * 1000;
}

/** Parse a simple `<n> <unit>` Postgres interval literal to milliseconds.
 *  Only the units the interval config emits are handled; anything else falls
 *  back to 2h (the AUTOMATION_RUN_STALE_INTERVAL default). */
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

/** Terminal execution failures that degrade an active automation. */
const FAILED_RUN_STATUSES = new Set(['failed', 'timeout']);

export interface AutomationHealthInput {
  /** Automation `status` (only `active` automations can be degraded). */
  status: string | null | undefined;
  /** `automations.next_run_at` — the scheduler cursor. */
  nextRunAt: string | Date | null | undefined;
  /** Latest run status (from buildLatestAutomationRunJoinSql). */
  latestRunStatus?: string | null;
  /** Latest run `created_at`, used to age a stuck pending run. */
  latestRunCreatedAt?: string | Date | null;
  /** Latest run `error_message`, surfaced as `last_scheduling_error`. */
  latestRunError?: string | null;
  /**
   * Latest run `runs.outcome` (infra_error/agent_error/scoreable), stamped at
   * write time by the terminal-status writers. Separates "the platform broke"
   * from "the agent misbehaved" in the degraded reason — the distinction the
   * July-2026 z.ai quota storm lacked. NULL on pre-backfill rows.
   */
  latestRunOutcome?: string | null;
}

export interface AutomationHealth {
  health: AutomationHealthStatus;
  /** Human-readable reasons the automation is degraded (empty when healthy). */
  reasons: string[];
  /** Latest run error, echoed for convenience (null when none). */
  last_scheduling_error: string | null;
  /** Latest run outcome classification, echoed for convenience (null when unstamped). */
  last_run_outcome: string | null;
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Derive an automation's health from already-selected fields.
 *
 * `degraded` when the automation is `active` AND any of:
 *   - its latest run ended in a terminal failure (`failed`/`timeout`) — the
 *     automation ran and broke, regardless of the scheduler cursor; or
 *   - its `next_run_at` is in the past by more than the missed-firing margin
 *     (a missed firing), UNLESS a run is currently in flight (claimed/running)
 *     — an active dispatch is healthy, we don't false-degrade mid-tick; or
 *   - its latest run is `pending` and older than the run stale interval
 *     (AUTOMATION_RUN_STALE_INTERVAL) — a stuck pending run the reaper hasn't
 *     timed out yet.
 * Otherwise `healthy`.
 */
export function computeAutomationHealth(
  input: AutomationHealthInput,
  now: number = Date.now()
): AutomationHealth {
  const reasons: string[] = [];
  const lastError = input.latestRunError ?? null;
  const lastOutcome = input.latestRunOutcome ?? null;

  // Archived automations are intentionally idle and therefore healthy.
  if (input.status !== 'active') {
    return {
      health: 'healthy',
      reasons,
      last_scheduling_error: lastError,
      last_run_outcome: lastOutcome,
    };
  }

  const runInFlight = IN_FLIGHT_RUN_STATUSES.has(input.latestRunStatus ?? '');

  if (FAILED_RUN_STATUSES.has(input.latestRunStatus ?? '')) {
    const label = lastOutcome
      ? `latest run ${input.latestRunStatus} (${lastOutcome})`
      : `latest run ${input.latestRunStatus}`;
    reasons.push(lastError ? `${label}: ${lastError}` : label);
  }

  // Missed firing: next_run_at is well in the past and nothing is dispatching.
  const nextRunMs = toMs(input.nextRunAt);
  if (!runInFlight && nextRunMs != null && nextRunMs < now - missedFiringMarginMs()) {
    const overdueMin = Math.round((now - nextRunMs) / 60_000);
    reasons.push(`missed firing: next_run_at overdue by ~${overdueMin} min`);
  }

  // Stuck pending run: latest run is pending past the stale interval (the
  // reaper should have timed it out; if it hasn't, the automation is wedged).
  if (input.latestRunStatus === 'pending') {
    const runCreatedMs = toMs(input.latestRunCreatedAt);
    const staleMs = pgIntervalToMs(intervals.automationRunStaleInterval);
    if (runCreatedMs != null && runCreatedMs < now - staleMs) {
      const stuckMin = Math.round((now - runCreatedMs) / 60_000);
      reasons.push(`stuck pending run: pending for ~${stuckMin} min`);
    }
  }

  return {
    health: reasons.length > 0 ? 'degraded' : 'healthy',
    reasons,
    last_scheduling_error: lastError,
    last_run_outcome: lastOutcome,
  };
}
