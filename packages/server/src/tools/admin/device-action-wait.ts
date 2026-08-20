/**
 * Wait for a device-bound action run (approval_mode='device') to finish.
 *
 * Extracted from manage_operations so dispatch-chrome-action can await device
 * completion without importing the full manage_operations module (breaks a
 * circular init cycle: manage_operations → dispatch-chrome-action →
 * manage_operations that left MANAGE_AUTOMATIONS_ACTION_KEY / manageAutomations in
 * TDZ and red-failed CI unit on main).
 */

import { DEVICE_ACTION_QUEUE_BUDGET_MS } from '../../config/intervals';
import { getDb } from '../../db/client';
import { classifyRunOutcome } from '../../runs/run-outcome';
import { describeDeviceLastSeen } from '../../utils/device-liveness';

/**
 * How long the device pinned to this run's connection has been silent.
 * Runs only on the pre-claim timeout path, so the extra round-trip costs
 * nothing on the happy path. Never throws: a diagnostic that can fail the
 * operation it is diagnosing is worse than no diagnostic.
 */
export async function describeRunDeviceLastSeen(
  runId: number,
  organizationId: string
): Promise<string> {
  try {
    const rows = (await getDb()`
      SELECT dw.label, dw.last_seen_at
      FROM runs r
      JOIN connections c ON c.id = r.connection_id
      JOIN device_workers dw ON dw.id = c.device_worker_id
      WHERE r.id = ${runId} AND r.organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{ label: string | null; last_seen_at: Date | string | null }>;
    const row = rows[0];
    if (!row) return 'run has no paired device';
    const age = describeDeviceLastSeen(row.last_seen_at);
    return row.label ? `device "${row.label}" ${age}` : `device ${age}`;
  } catch {
    return 'device liveness unavailable';
  }
}

/**
 * Sleep between polls, but wake IMMEDIATELY on abort.
 *
 * A plain `setTimeout` would hold an aborted wait for the rest of the poll
 * interval before the loop noticed, and the caller's run stays in flight —
 * claimable, and still holding its payload — for that whole window. Callers
 * with a short deadline (ambient recall) measure their budget in a handful of
 * poll intervals, so "up to 500ms late" is a meaningful share of it.
 *
 * The listener is always removed: this runs once per poll for the life of the
 * wait, and a signal that outlives the loop would otherwise accumulate them.
 */
async function sleepUnlessAborted(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (abortSignal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    abortSignal.addEventListener('abort', done, { once: true });
  });
}

// Deadline strategy: two phases.
//
//   - PRE-CLAIM (status='pending'): how long the device has to even
//     pick the run up. The chrome extension polls /poll every 5s; we
//     allow up to the shared device-action queue budget for it to arrive.
//
//   - POST-CLAIM (status='running'): how long the device has to
//     execute, after it claimed the run. The chrome extension's own
//     per-run watchdog (tools.js RUN_TIMEOUT_MS=90s) caps this; we
//     allow that + buffer so the gateway never times out a
//     legitimately-running tool.
//
// Without the two-phase split, a slow poll cycle (worker offline for
// 20-30s) could exhaust a flat-100s deadline before the worker even
// claimed the run, marking it timeout while the worker was about to
// pick it up.
export async function waitForDeviceActionRun(
  runId: number,
  organizationId: string,
  /**
   * Abort the wait early (e.g. an automation reaction hit its wall-clock budget).
   * On abort we stop polling and finalize the run as `timeout` so the orphaned
   * poll loop and any in-flight device work don't leak past the caller.
   */
  abortSignal?: AbortSignal,
): Promise<{
  status: 'completed' | 'failed' | 'timeout';
  // `action_output` is arbitrary connector/device JSON — object, array, or
  // scalar — so the completed output is `unknown`, not an object.
  output?: unknown;
  error_message?: string;
}> {
  const sql = getDb();
  const POST_CLAIM_BUDGET_MS = 95_000; // matches extension's 90s + 5s buffer
  const POLL_MS = 500;
  const queueDeadline = Date.now() + DEVICE_ACTION_QUEUE_BUDGET_MS;
  let claimedAtMs: number | null = null;

  while (true) {
    const rows = (await sql`
      SELECT status, action_output, error_message, claimed_at
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: unknown;
      error_message: string | null;
      claimed_at: Date | string | null;
    }>;
    const row = rows[0];
    if (!row) {
      return {
        status: 'failed',
        error_message: `Run ${runId} disappeared from runs table while waiting.`,
      };
    }
    if (row.status === 'completed') {
      return {
        status: 'completed',
        output: row.action_output ?? {},
      };
    }
    if (row.status === 'failed' || row.status === 'timeout') {
      return {
        status: row.status as 'failed' | 'timeout',
        error_message: row.error_message ?? `Run ${runId} ${row.status}`,
      };
    }
    // Still pending or running. Check the right deadline for this phase.
    if (row.claimed_at && claimedAtMs == null) {
      claimedAtMs =
        row.claimed_at instanceof Date
          ? row.claimed_at.getTime()
          : new Date(row.claimed_at).getTime();
    }
    // Caller aborted (e.g. reaction timeout) — stop polling and let the
    // timeout finalization below mark the run, so we don't leak this loop.
    if (abortSignal?.aborted) break;
    const now = Date.now();
    if (claimedAtMs != null) {
      if (now - claimedAtMs >= POST_CLAIM_BUDGET_MS) break;
    } else {
      if (now >= queueDeadline) break;
    }
    await sleepUnlessAborted(POLL_MS, abortSignal);
  }

  // Which phase timed out decides what the operator needs to hear. A run that
  // was never CLAIMED failed because no device asked for it, and the server
  // knows exactly how long that device has been quiet — say so instead of
  // "the device may be offline", which sends the reader looking for a fault
  // that is already measured here. A run that WAS claimed died mid-execution
  // on the device, where last_seen tells you nothing.
  // Looked up ONCE and used for both the stored `runs.error_message` and the
  // string returned to the caller below — those are two different readers of
  // the same failure and both used to say "may be offline".
  const deviceDiagnostic =
    claimedAtMs != null
      ? null
      : await describeRunDeviceLastSeen(runId, organizationId);
  const timeoutMessage =
    deviceDiagnostic == null
      ? 'waitForDeviceActionRun: device claimed the run but did not complete in time'
      : `waitForDeviceActionRun: no device claimed the run within ${Math.round(
          DEVICE_ACTION_QUEUE_BUDGET_MS / 1000
        )}s (${deviceDiagnostic})`;

  // Atomic timeout finalization. The WHERE clause matches only non-
  // terminal states; if the worker raced us and posted completion
  // between our last SELECT and this UPDATE, this UPDATE is a no-op
  // and we re-read the row to surface the worker's verdict.
  const updated = (await sql`
    UPDATE runs
    SET status = 'timeout',
        outcome = ${classifyRunOutcome({ status: 'timeout' })},
        completed_at = current_timestamp,
        error_message = ${timeoutMessage}
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND status IN ('pending', 'running')
    RETURNING id
  `) as Array<{ id: number }>;

  if (updated.length === 0) {
    // Worker won the race. Re-read to return whatever it actually said.
    const finalRows = (await sql`
      SELECT status, action_output, error_message
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: Record<string, unknown> | null;
      error_message: string | null;
    }>;
    const final = finalRows[0];
    if (final?.status === 'completed') {
      return {
        status: 'completed',
        output: (final.action_output ?? {}) as Record<string, unknown>,
      };
    }
    if (final?.status === 'failed') {
      return {
        status: 'failed',
        error_message: final.error_message ?? `Run ${runId} failed`,
      };
    }
    // Shouldn't reach here, but fall through to timeout.
  }

  return {
    status: 'timeout',
    error_message:
      deviceDiagnostic == null
        ? `Run ${runId} claimed but the device worker didn't finish within ${POST_CLAIM_BUDGET_MS}ms.`
        : `Run ${runId} was never claimed within ${DEVICE_ACTION_QUEUE_BUDGET_MS}ms — ${deviceDiagnostic}.`,
  };
}
