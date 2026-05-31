-- migrate:up

-- Derived (SQL-view-backed) entity types. Today every entity type is "stored"
-- (rows are inserted/validated against metadata_schema). A "derived" entity type
-- is instead a read-only SQL view over other relations (events, other entities);
-- it has no stored rows — its data comes from running backing_sql via query_sql.
--
-- Decision B: a typed first-class column (not a metadata jsonb blob) so apply can
-- diff it and the read path can read it without parsing. There is NO separate mode
-- column — a type is derived iff backing_sql IS NOT NULL. Measure/dimension roles
-- are classified ON READ from backing_sql, not persisted.
--
-- Idempotent: no-op on databases that already have the column.
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS backing_sql text;

-- migrate:down

ALTER TABLE public.entity_types DROP COLUMN IF EXISTS backing_sql;
