-- migrate:up

-- Convert entities.entity_type from a text slug to an FK on entity_types(id).
-- Two motivations folded into one change:
--
--   1. Integrity. Today entity_types renames orphan all referencing entities
--      (slug-based reference is silent FK with no enforcement). Hard-deletes
--      bypass the validator entirely. With a real FK, Postgres refuses to
--      drop a referenced type and renames update for free (the slug becomes
--      display only — JOIN to entity_types for it).
--
--   2. Cross-org vocabulary. entity_types.id is globally unique (one sequence
--      across all orgs), so an entity in tenant org A can carry a type defined
--      in public-catalog org B by FK alone. No additional org_id column on
--      entities is needed once the slug-based same-org coupling is gone.
--
-- Single-prod-DB migration: add nullable column, backfill, fail loudly on
-- orphans, set NOT NULL, drop the text column. Run manually.

-- 1. Add the FK column, nullable for backfill.
ALTER TABLE public.entities
    ADD COLUMN entity_type_id integer REFERENCES public.entity_types(id);

-- 2. Backfill from existing (organization_id, entity_type slug) → entity_types.id.
-- Soft-deleted entity_types still resolve — preserves history of soft-removed types.
UPDATE public.entities e
SET entity_type_id = et.id
FROM public.entity_types et
WHERE et.slug = e.entity_type
  AND et.organization_id = e.organization_id
  AND e.entity_type_id IS NULL;

-- 3. Fail loudly on orphans. If any entities reference a slug with no matching
-- entity_types row, that's pre-existing data corruption from the slug-based
-- regime. Surface it; don't paper over.
DO $$
DECLARE
    orphan_count integer;
BEGIN
    SELECT COUNT(*) INTO orphan_count FROM public.entities WHERE entity_type_id IS NULL;
    IF orphan_count > 0 THEN
        RAISE EXCEPTION
          'entity_type FK migration: % entities have entity_type slugs with no matching entity_types row. Investigate before re-running.',
          orphan_count;
    END IF;
END $$;

-- 4. Tighten the FK column.
ALTER TABLE public.entities
    ALTER COLUMN entity_type_id SET NOT NULL;

-- 5. Index for filter/list queries that previously used entity_type slug.
CREATE INDEX idx_entities_entity_type_id
    ON public.entities (entity_type_id)
    WHERE deleted_at IS NULL;

-- 6. Drop the text column. All readers JOIN to entity_types for the slug.
ALTER TABLE public.entities DROP COLUMN entity_type;


-- migrate:down

ALTER TABLE public.entities ADD COLUMN entity_type text;

UPDATE public.entities e
SET entity_type = et.slug
FROM public.entity_types et
WHERE et.id = e.entity_type_id;

ALTER TABLE public.entities ALTER COLUMN entity_type SET NOT NULL;

DROP INDEX IF EXISTS public.idx_entities_entity_type_id;

ALTER TABLE public.entities DROP COLUMN entity_type_id;
