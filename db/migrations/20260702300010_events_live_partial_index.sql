-- migrate:up transaction:false

-- Partial index backing the flipped current_event_records predicate
-- (`WHERE superseded_by IS NULL`, next migration). Org-scoped chronological
-- reads (get_content, metrics/compiler.ts rewrites events →
-- current_event_records, utils/execute-data-sources.ts) filter on
-- organization_id then order by created_at, so key the live-row index on
-- (organization_id, created_at) restricted to live rows. In prod ~75% of rows
-- are superseded, so this indexes only the ~25% that reads actually want.
--
-- Ordered AFTER the backfill migration on purpose: building it before the
-- backfill would index the ~1.5M then-unstamped rows only to delete them all
-- from the index moments later (bloat). CONCURRENTLY (transaction:false, one
-- statement per squawk) so the build never blocks writes on the high-write
-- events table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_live_org_created
  ON public.events (organization_id, created_at)
  WHERE superseded_by IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_live_org_created;
