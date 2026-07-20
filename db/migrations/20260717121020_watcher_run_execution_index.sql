-- migrate:up transaction:false

-- Queue policy is now part of the trigger. Multiple pending event deliveries
-- may wait for one Behavior, but only one run may execute at a time. Create the
-- replacement invariant before removing the stricter legacy index.
--
-- IF NOT EXISTS does not repair an INVALID same-named index left by an
-- interrupted concurrent build. Drop only that carcass before rebuilding;
-- the migration runners execute this DO separately from CREATE CONCURRENTLY.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_runs_executing_watcher_per_watcher'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_runs_executing_watcher_per_watcher';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_executing_watcher_per_watcher
  ON runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status IN ('claimed', 'running');

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_executing_watcher_per_watcher;
