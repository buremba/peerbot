-- migrate:up transaction:false
-- lobu:no-quiesce

-- Additive partial expression index used to find an exact source claim on live
-- relationships. Operational cost is a concurrent build (two passes over
-- entity_relationships); writes remain available. This was not benchmarked on a
-- prod-sized copy, so verify indisvalid after deploy if the 60s migration
-- statement_timeout interrupts the build.
-- No ownership backfill is performed, and this index does not create one:
-- relationships without a claim stay unmanageable through manage_entity
-- update_link/unlink, and a connector declaring an edge that already exists
-- unclaimed fails its batch. Shared first-party edge writers stamp explicit
-- config claims after this cutover; pre-cutover rows still need an owner-chosen
-- manual or config claim before connector relationship ingestion is enabled.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_relationships_live_claims
  ON public.entity_relationships
  USING gin ((metadata -> '_lobu_claims'))
  WHERE deleted_at IS NULL AND metadata ? '_lobu_claims';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;
