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
-- Prefer live entity_types rows; fall back to soft-deleted ones to preserve
-- history. Without the ORDER BY, a slug+org pair with both an active and a
-- soft-deleted row would resolve non-deterministically — entity_types' UNIQUE
-- index on slug only covers `deleted_at IS NULL` rows, so collisions can exist.
UPDATE public.entities e
SET entity_type_id = (
  SELECT et.id
  FROM public.entity_types et
  WHERE et.slug = e.entity_type
    AND et.organization_id = e.organization_id
  ORDER BY (et.deleted_at IS NULL) DESC, et.id DESC
  LIMIT 1
)
WHERE e.entity_type_id IS NULL;

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

-- 6. Drop the redundant UNIQUE constraint that referenced entity_type. The
-- stronger `entities_slug_parent_unique` (UNIQUE on org_id, COALESCE(parent_id,
-- 0), slug) already enforces slug uniqueness within (org, parent) regardless
-- of entity type, with NULL-parent collapsing — so this constraint never
-- caught anything the index didn't already catch. Drop it explicitly rather
-- than letting DROP COLUMN cascade silently.
ALTER TABLE public.entities
    DROP CONSTRAINT IF EXISTS entities_organization_id_entity_type_slug_parent_id_key;

-- 7. Drop the column comment so DROP COLUMN doesn't carry a stale doc string
-- if this migration is ever rolled back and re-applied.
COMMENT ON COLUMN public.entities.entity_type IS NULL;

-- 8. Drop the text column. All readers JOIN to entity_types for the slug.
ALTER TABLE public.entities DROP COLUMN entity_type;


-- migrate:down

ALTER TABLE public.entities ADD COLUMN entity_type text;

UPDATE public.entities e
SET entity_type = et.slug
FROM public.entity_types et
WHERE et.id = e.entity_type_id;

ALTER TABLE public.entities ALTER COLUMN entity_type SET NOT NULL;

COMMENT ON COLUMN public.entities.entity_type IS
    'Type of entity: brand, product (future: location, feature, team)';

ALTER TABLE public.entities
    ADD CONSTRAINT entities_organization_id_entity_type_slug_parent_id_key
    UNIQUE (organization_id, entity_type, slug, parent_id);

DROP INDEX IF EXISTS public.idx_entities_entity_type_id;

ALTER TABLE public.entities DROP COLUMN entity_type_id;
