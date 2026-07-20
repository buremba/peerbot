-- migrate:up transaction:false

-- Event triggers may queue multiple pending deliveries. Scheduled/manual runs
-- keep the legacy one-pending-run invariant so old scheduler replicas remain
-- race-safe during the rolling deployment. Legacy payloads have no
-- dispatch_source and are therefore treated as scheduled.
--
-- INVALID-carcass heal runs first in the companion migration
-- 20260717121024_pending_non_event_watcher_run_index_heal.sql. Single statement
-- so dbmate does not wrap CONCURRENTLY in an implicit transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_pending_non_event_watcher_per_watcher
  ON runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status = 'pending'
    AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_pending_non_event_watcher_per_watcher;
