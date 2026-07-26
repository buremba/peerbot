/**
 * Long-horizon expiry for undecided approvals.
 *
 * A run queued behind a human gate lands at `approval_status='pending'` and is
 * DELIBERATELY exempt from the short-horizon claim reaper (#2044, see
 * scheduled/stale-run-sweeper.ts): no worker will ever claim it, so timing it
 * out on the 120s claim horizon would kill the run before anyone could decide.
 * That exemption was never paired with a long-horizon expiry, so undecided
 * approvals accumulated forever — cluttering the approvals surface and keeping
 * side effects queued against inputs that went stale months ago.
 *
 * This reaper closes that hole at the OTHER end of the timescale: rows still
 * pending after `intervals.pendingApprovalTtlDays` (default 7 DAYS) go terminal
 * at `approval_status='expired', status='cancelled'`. It never touches anything
 * inside the TTL, so the #2044 grace window is untouched — the two reapers do
 * not overlap in the horizons they cover.
 *
 * 'expired' is a distinct value, not a reuse of 'rejected': rejection is a HUMAN
 * decision the batch-reject path feeds back to the Behavior as a `correction` to
 * learn from, while expiry is the system giving up on an undecided run. An agent
 * must not train on silence as if it were disapproval.
 *
 * Scope is both human-gated lanes — `action` (connector operations) and
 * `internal` (builder / entity-change / Behavior proposals). Nothing else can
 * hold `approval_status='pending'`.
 *
 * Multi-pod safety: the UPDATE re-asserts `approval_status = 'pending'`, so it
 * is the authoritative claim — a row a human approved between scan and write is
 * excluded by the predicate, and two overlapping runners can never both expire
 * the same row (only one UPDATE matches). Pure Postgres, correct under N>1
 * replicas; RETURNING drives the card supersede so each expiry is announced
 * exactly once.
 */

import { intervals } from '../config/intervals';
import { getDb, pgTextArray } from '../db/client';
import { supersedeActionEvent } from '../tools/admin/manage_operations';
import logger from '../utils/logger';

/** Lanes that can hold `approval_status='pending'`. */
const APPROVAL_RUN_TYPES = ['action', 'internal'] as const;

/** Cap on rows expired per tick so one sweep can't hold a long write burst. */
const EXPIRY_BATCH_LIMIT = 500;

interface ExpiredApprovalRow {
  id: string | number;
  organization_id: string;
  action_key: string | null;
}

export interface ExpirePendingApprovalsResult {
  /** Rows transitioned pending → expired this tick. */
  expired: number;
}

/**
 * One pass of the pending-approval expiry sweep. Idempotent: a row already
 * expired no longer matches `approval_status = 'pending'`.
 */
export async function expirePendingApprovals(
  ttlDays: number = intervals.pendingApprovalTtlDays,
): Promise<ExpirePendingApprovalsResult> {
  const sql = getDb();
  const reason = `Approval expired: nobody decided within ${ttlDays} day${ttlDays === 1 ? '' : 's'}.`;

  // Authoritative claim + transition in one statement. The inner SELECT bounds
  // the batch oldest-first; the UPDATE re-asserts the full pending predicate so
  // a row decided between scan and write is left to the human who decided it.
  const expired = (await sql`
    UPDATE runs
    SET approval_status = 'expired',
        status = 'cancelled',
        error_message = ${reason},
        completed_at = NOW()
    WHERE id IN (
      SELECT id FROM runs
      WHERE approval_status = 'pending'
        AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
        AND created_at < NOW() - (${ttlDays}::int * interval '1 day')
      ORDER BY created_at ASC
      LIMIT ${EXPIRY_BATCH_LIMIT}
    )
      AND approval_status = 'pending'
    RETURNING id, organization_id, action_key
  `) as unknown as ExpiredApprovalRow[];

  // Supersede each approval card so the UI stops offering a dead Approve button.
  // `events` is append-only — supersedeActionEvent appends a superseding row, it
  // never deletes. interaction_status has no 'expired' member, so the card lands
  // as 'rejected' (it is no longer actionable, which is what the renderer keys
  // off); the precise reason lives on runs.approval_status + the event metadata.
  // Best-effort per row: a card that can't be superseded must not strand the
  // remaining rows, which are already terminal in the database.
  for (const row of expired) {
    const runId = Number(row.id);
    const label = row.action_key ?? 'approval';
    try {
      await supersedeActionEvent(
        runId,
        row.organization_id,
        'rejected',
        `${label} — expired`,
        reason,
        { reason, expired: true, expired_after_days: ttlDays },
      );
    } catch (error) {
      logger.warn(
        { runId, organizationId: row.organization_id, error: String(error) },
        '[task] expire-pending-approvals: card supersede failed (row already expired)',
      );
    }
  }

  return { expired: expired.length };
}

/** Scheduled-task wrapper: run the sweep and log a summary. */
export async function runExpirePendingApprovals(): Promise<void> {
  const result = await expirePendingApprovals();
  if (result.expired > 0) {
    logger.info({ ...result }, '[task] expire-pending-approvals completed');
  }
}
