-- migrate:up

-- Pending builder-approval runs created by the removed manage_watchers tool
-- (action_key = 'manage_watchers', run_type = 'internal', no connection) can no
-- longer be claimed by tryApproveBuilderRun / tryRejectBuilderRun, which only
-- match manage_agents / manage_behaviors. Approve/reject falls through to the
-- connector-operation executor and fails permanently (no connection_id), leaving
-- undismissable approval cards and unrecoverable held mutations.
--
-- Terminal-resolve them exactly as tryRejectBuilderRun / claimBuilderRun would
-- on rejection: approval_status='rejected', status='cancelled', error_message +
-- completed_at set. Predicate mirrors the claim query's pending-state check
-- (approval_status = 'pending' AND run_type = 'internal') scoped to the removed
-- action_key only. Idempotent: re-running matches 0 rows after the first pass.
UPDATE runs
SET approval_status = 'rejected',
    status = 'cancelled',
    error_message = 'Cancelled: manage_watchers was removed; re-request via manage_behaviors if still needed',
    completed_at = NOW()
WHERE run_type = 'internal'
  AND action_key = 'manage_watchers'
  AND approval_status = 'pending';

-- migrate:down

-- No-op: distinguishing rows cancelled here from organically rejected ones is
-- not possible after the fact, and re-pending them would reintroduce the stuck
-- undismissable cards this migration clears.
SELECT 1;
