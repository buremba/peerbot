-- migrate:up transaction:false

-- Second half of the queue-policy index swap. Keep this in its own migration:
-- Postgres rejects multiple CONCURRENTLY statements sent as one implicit batch.
DROP INDEX CONCURRENTLY IF EXISTS idx_runs_active_watcher_per_watcher;

-- migrate:down transaction:false

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_active_watcher_per_watcher
  ON runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status IN ('pending', 'claimed', 'running');
