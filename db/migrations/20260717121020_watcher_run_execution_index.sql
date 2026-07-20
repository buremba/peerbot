-- migrate:up transaction:false

-- Queue policy is now part of the trigger. Multiple pending event deliveries
-- may wait for one Behavior, but only one run may execute at a time.
--
-- INVALID-carcass heal runs first in the companion migration
-- 20260717121019_watcher_run_execution_index_heal.sql. This file is a SINGLE
-- statement so dbmate does not run CONCURRENTLY inside an implicit transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_executing_watcher_per_watcher
  ON runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status IN ('claimed', 'running');

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_executing_watcher_per_watcher;
