-- migrate:up transaction:false

-- Org-scope bridge, denormalized (schema part 2: GIN index).
-- Companion to 20260804170000_events_linked_org_ids.sql, split out because
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction and db:lint
-- (squawk) bans non-concurrent builds on the hot events table. One statement
-- per transaction:false migration — dbmate sends the block as one
-- simple-query batch and CONCURRENTLY can't share it.
--
-- Serves the denormalized org-scope predicate:
--   organization_id = $org OR linked_org_ids @> ARRAY[$org]
-- The containment branch BitmapOrs with the organization_id btree branch.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_linked_org_ids
  ON public.events USING gin (linked_org_ids);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_linked_org_ids;
