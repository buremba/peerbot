-- migrate:up transaction:false

-- Runs-retention cleanup runs constantly (check-stalled-executions + the
-- runs-queue pruners) deleting terminal runs older than their retention
-- window. The "find rows to delete" subquery filters
--   status IN (terminal) AND completed_at < now() - N days
-- but there is no index on completed_at, so every sweep did a full seq scan
-- of `runs` (~294k rows, removing ~98k per parallel worker) to match a
-- handful of rows — the steady-state backlog is tiny because the sweep keeps
-- it drained. pg_stat: ~20k calls × ~700ms mean.
--
-- Partial index on completed_at for terminal statuses lets the sweep range
-- scan directly to the old rows instead of scanning the whole table. One
-- statement per transaction:false migration (CONCURRENTLY can't share a
-- batch).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_terminal_completed_at
  ON public.runs (completed_at)
  WHERE status IN ('completed', 'failed', 'timeout', 'cancelled')
    AND completed_at IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_terminal_completed_at;
