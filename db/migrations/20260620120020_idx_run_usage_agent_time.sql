-- migrate:up transaction:false

-- Per-agent showback rollup, fenced to (organization_id, agent_id) then
-- occurred_at DESC. CONCURRENTLY, one statement per transaction:false migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_usage_agent_time
    ON public.run_usage (organization_id, agent_id, occurred_at DESC);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_run_usage_agent_time;
