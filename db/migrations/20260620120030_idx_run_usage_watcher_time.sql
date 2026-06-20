-- migrate:up transaction:false

-- Per-watcher showback + the per-watcher spend cap, fenced to
-- (organization_id, watcher_id) then occurred_at DESC. PARTIAL on
-- watcher_id IS NOT NULL: most runs are chat/agent (NULL watcher_id) and would
-- only bloat a per-watcher index, so they're excluded outright. CONCURRENTLY,
-- one statement per transaction:false migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_usage_watcher_time
    ON public.run_usage (organization_id, watcher_id, occurred_at DESC)
    WHERE watcher_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_run_usage_watcher_time;
