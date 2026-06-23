-- migrate:up

-- Schema lives on the entity type: a watcher that names keying_config.entity_type
-- derives its extraction schema from that type's metadata_schema, so it stores NO
-- inline extraction_schema (NULL = "derive from the entity type"). Relax the
-- NOT NULL so entity-typed watchers can omit it. Existing watchers keep their
-- inline schema unchanged. DROP NOT NULL is a fast catalog-only change.
ALTER TABLE public.watcher_versions ALTER COLUMN extraction_schema DROP NOT NULL;

-- migrate:down

-- Re-impose NOT NULL. Backfill the entity-typed watchers' NULLs with an empty
-- object so the constraint can be restored without data loss.
UPDATE public.watcher_versions SET extraction_schema = '{}'::jsonb WHERE extraction_schema IS NULL;
ALTER TABLE public.watcher_versions ALTER COLUMN extraction_schema SET NOT NULL;
