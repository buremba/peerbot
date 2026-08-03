-- migrate:up

-- Schema lives on the entity type, so entity-producing Behaviors derive their
-- extraction schema from that type's metadata_schema and store no inline
-- extraction_schema (NULL = "derive from durable outputs"). Relax the NOT NULL
-- so these Behaviors can omit it. Existing rows keep their inline schema.
ALTER TABLE public.watcher_versions ALTER COLUMN extraction_schema DROP NOT NULL;

-- migrate:down

-- Re-impose NOT NULL. Backfill the entity-typed watchers' NULLs with an empty
-- object so the constraint can be restored without data loss.
UPDATE public.watcher_versions SET extraction_schema = '{}'::jsonb WHERE extraction_schema IS NULL;
ALTER TABLE public.watcher_versions ALTER COLUMN extraction_schema SET NOT NULL;
