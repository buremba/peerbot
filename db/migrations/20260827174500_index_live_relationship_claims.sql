-- migrate:up transaction:false
-- lobu:no-quiesce

-- Additive partial expression index used to find an exact source claim on live
-- relationships. Operational cost is one concurrent scan of
-- entity_relationships; writes remain available. This was not benchmarked on a
-- prod-sized copy, so verify indisvalid after deploy if the 60s migration
-- statement_timeout interrupts the build.
-- No ownership backfill is performed: existing ordinary relationships must be
-- classified and moved to a manual/source claim explicitly before cutover.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_relationships_live_claims
  ON public.entity_relationships
  USING gin ((metadata -> '_lobu_claims'))
  WHERE deleted_at IS NULL AND metadata ? '_lobu_claims';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;
