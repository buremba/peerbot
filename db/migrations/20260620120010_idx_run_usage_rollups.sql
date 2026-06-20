-- migrate:up transaction:false

-- Showback + caps read pattern: SUM/GROUP BY a dimension fenced to a sliding
-- time window. Each composite leads with the scoping dimension(s) then
-- occurred_at DESC, so a windowed rollup is served from an ordered index range
-- scan instead of a full-table scan + sort. CONCURRENTLY so the builds never
-- block snapshot/usage writes. (watcher_id index is for the per-watcher caps;
-- nulls for non-watcher runs are simply absent from that index.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_usage_org_time
    ON public.run_usage (organization_id, occurred_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_usage_agent_time
    ON public.run_usage (organization_id, agent_id, occurred_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_usage_watcher_time
    ON public.run_usage (organization_id, watcher_id, occurred_at DESC);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_run_usage_org_time;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_run_usage_agent_time;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_run_usage_watcher_time;
