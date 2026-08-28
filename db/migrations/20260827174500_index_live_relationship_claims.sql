-- migrate:up transaction:false

-- Relationships created before claim ownership existed are user-managed.
-- Stamp them as manual once so they remain editable after the cutover; all
-- post-cutover writers attach their exact ownership claim when inserting.
UPDATE public.entity_relationships
SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      ARRAY['_lobu_claims']::text[],
      '{"manual": {}}'::jsonb,
      true
    ),
    updated_at = current_timestamp
WHERE deleted_at IS NULL
  AND NOT (COALESCE(metadata, '{}'::jsonb) ? '_lobu_claims');

-- Partial expression index used to find exact claims on live relationships.
-- A failed concurrent build leaves an invalid index behind; remove it so a
-- migration retry always performs a real build instead of trusting the name.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_relationships_live_claims
  ON public.entity_relationships
  USING gin ((metadata -> '_lobu_claims'))
  WHERE deleted_at IS NULL AND metadata ? '_lobu_claims';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;
