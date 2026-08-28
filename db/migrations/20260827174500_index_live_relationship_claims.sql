-- migrate:up transaction:false

-- Partial expression index used to find exact claims on live relationships.
-- This cutover deliberately does not infer ownership for pre-feature rows;
-- migrate or recreate those rows explicitly before connector ingestion.
-- A failed concurrent build leaves an invalid index behind; remove it so a
-- migration retry always performs a real build instead of trusting the name.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_relationships_live_claims
  ON public.entity_relationships
  USING gin ((metadata -> '_lobu_claims'))
  WHERE deleted_at IS NULL AND metadata ? '_lobu_claims';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;
