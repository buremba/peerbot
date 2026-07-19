-- migrate:up transaction:false

-- Queue policy is now part of the trigger. Multiple pending event deliveries
-- may wait for one Behavior, but only one run may execute at a time. Create the
-- replacement invariant before removing the stricter legacy index.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_executing_watcher_per_watcher
  ON runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status IN ('claimed', 'running');

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_executing_watcher_per_watcher;
