-- migrate:up

-- Partial index for the dashboard's 14-day lifecycle-cumulative-stats query
-- (lifecycleCumulativeStatsSql in packages/web/src/lib/api/metric-series.ts).
--
-- The query reads events older than `now() - interval '14 days'` and
-- aggregates by date_trunc('day', created_at), with every COUNT FILTER
-- already gated on semantic_type='change' AND metadata->>'category'='lifecycle'.
-- A partial index whose predicate matches that gate prunes the scan from
-- "all events in the last 14 days for the org" to "just the lifecycle
-- changes" — typically a small slice of total events. The aggregation
-- itself is cheap once the row set is narrow.
--
-- Why not a materialized view: at current scale the bottleneck is the row
-- scan, not the per-bucket COUNT FILTER work. A partial index removes the
-- scan cost without introducing a refresh job or staleness. Revisit if the
-- post-prune row count grows into the millions.

CREATE INDEX idx_events_lifecycle_changes
    ON public.events (organization_id, created_at)
    WHERE semantic_type = 'change' AND metadata->>'category' = 'lifecycle';

-- migrate:down

DROP INDEX IF EXISTS public.idx_events_lifecycle_changes;
