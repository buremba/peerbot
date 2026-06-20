-- migrate:up transaction:false

-- Per-org showback + the org spend cap fence to a sliding time window; the
-- composite leads with organization_id then occurred_at DESC so a windowed
-- rollup is an ordered index range scan. CONCURRENTLY (one statement per
-- transaction:false migration — Postgres rejects CREATE INDEX CONCURRENTLY in a
-- multi-statement transaction block) so the build never blocks usage writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_usage_org_time
    ON public.run_usage (organization_id, occurred_at DESC);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_run_usage_org_time;
