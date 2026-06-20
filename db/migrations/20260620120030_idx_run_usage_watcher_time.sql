-- migrate:up transaction:false

-- Per-watcher showback + the per-watcher spend cap, fenced to
-- (organization_id, watcher_id) then occurred_at DESC. Non-watcher runs (NULL
-- watcher_id) are simply absent from this index. CONCURRENTLY, one statement
-- per transaction:false migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_usage_watcher_time
    ON public.run_usage (organization_id, watcher_id, occurred_at DESC);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_run_usage_watcher_time;
