-- migrate:up
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_watcher_per_watcher
  ON runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status IN ('pending', 'claimed', 'running');

-- migrate:down
DROP INDEX IF EXISTS idx_runs_active_watcher_per_watcher;
