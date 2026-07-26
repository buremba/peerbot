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
 * excluded by the predicate, and only one overlapping runner can commit an
 * expiry for a row. Pure Postgres, correct under N>1 replicas. The run
 * transition and card supersession share a transaction: if the event write
 * fails, the run remains pending for the next sweep.
 */

import { intervals } from "../config/intervals";
import { getDb, pgTextArray } from "../db/client";
import { supersedeActionEvent } from "../tools/admin/manage_operations";
import logger from "../utils/logger";

/** Lanes that can hold `approval_status='pending'`. */
const APPROVAL_RUN_TYPES = ["action", "internal"] as const;

/** Cap on rows expired per tick so one sweep can't hold a long write burst. */
const EXPIRY_BATCH_LIMIT = 500;

interface ExpiredApprovalRow {
	id: string | number;
	organization_id: string;
	action_key: string | null;
}

interface PendingApprovalCandidate {
	id: string | number;
}

interface ExpirePendingApprovalsResult {
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
	const reason = `Approval expired: nobody decided within ${ttlDays} day${ttlDays === 1 ? "" : "s"}.`;

	const candidates = (await sql`
    SELECT id FROM runs
    WHERE approval_status = 'pending'
      AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
      AND created_at < NOW() - (${ttlDays}::int * interval '1 day')
    ORDER BY created_at ASC
    LIMIT ${EXPIRY_BATCH_LIMIT}
  `) as unknown as PendingApprovalCandidate[];

	let expiredCount = 0;
	for (const candidate of candidates) {
		try {
			const didExpire = await sql.begin(async (tx) => {
				// Re-assert the full candidate predicate while claiming the row. A human
				// decision or another replica's committed expiry wins before this write.
				const rows = (await tx`
      UPDATE runs
      SET approval_status = 'expired',
          status = 'cancelled',
          error_message = ${reason},
          completed_at = NOW()
      WHERE id = ${candidate.id}
        AND approval_status = 'pending'
        AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
        AND created_at < NOW() - (${ttlDays}::int * interval '1 day')
      RETURNING id, organization_id, action_key
        `) as unknown as ExpiredApprovalRow[];
				const row = rows[0];
				if (!row) return false;

				// `events` stays append-only. interaction_status has no 'expired'
				// member, so the card uses 'rejected' as its non-actionable UI state
				// while run status and metadata retain the precise expiry reason.
				const runId = Number(row.id);
				const label = row.action_key ?? "approval";
				await supersedeActionEvent(
					runId,
					row.organization_id,
					"rejected",
					`${label} — expired`,
					reason,
					{ reason, expired: true, expired_after_days: ttlDays },
					null,
					tx,
				);
				return true;
			});
			if (didExpire) expiredCount += 1;
		} catch (error) {
			logger.warn(
				{
					runId: Number(candidate.id),
					error: String(error),
				},
				"[task] expire-pending-approvals: expiry rolled back after card supersede failure",
			);
		}
	}

	return { expired: expiredCount };
}

/** Scheduled-task wrapper: run the sweep and log a summary. */
export async function runExpirePendingApprovals(): Promise<void> {
	const result = await expirePendingApprovals();
	if (result.expired > 0) {
		logger.info({ ...result }, "[task] expire-pending-approvals completed");
	}
}
