-- migrate:up transaction:false

-- Partial index for the Deployments feed (deployment-routes.ts GET /):
-- org-scoped keyset pagination over config-audit and deployment-summary
-- events, ordered id DESC (the append-only slice's total order — the feed
-- cursors on id, not created_at, because JSON serializes timestamps at
-- millisecond precision while Postgres stores microseconds). Mirrors the
-- category-restricted-partial shape of idx_events_lifecycle_changes — these
-- rows are a tiny slice of the events table, so the index stays small. Also
-- serves the per-resource `before` LATERAL in the detail routes (org
-- equality + id ordering). CONCURRENTLY (transaction:false, one statement
-- per squawk) so the build never blocks writes on the high-write events
-- table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_config_changes
  ON public.events (organization_id, id DESC)
  WHERE semantic_type = 'change'
    AND metadata->>'category' IN ('config', 'deployment');

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_config_changes;
