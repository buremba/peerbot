-- migrate:up

-- Derived (SQL-view-backed) entity types. Today every entity type is "stored"
-- (rows are inserted/validated against metadata_schema). A "derived" entity type
-- is instead a read-only SQL view over other relations (events, other entities,
-- or — later — an external SQL source); its aggregate columns become measures.
--
-- Decision B: typed first-class columns (not a metadata jsonb blob) so apply can
-- diff them and query_sql/metric paths can read them without parsing. There is NO
-- separate mode column — a type is derived iff backing_sql IS NOT NULL.
--   backing_sql    — the ANSI SELECT for a derived view (NULL ⇒ stored)
--   backing_grain  — canonical-fact key; NULL means the default
--                    (organization_id, connection_id, origin_id) for embedded-events views
--   backing_source — connection key the view reads from; NULL means the embedded events store
--
-- Idempotent: no-op on databases that already have the columns.
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS backing_sql text;
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS backing_grain text[];
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS backing_source text;

-- migrate:down

ALTER TABLE public.entity_types DROP COLUMN IF EXISTS backing_source;
ALTER TABLE public.entity_types DROP COLUMN IF EXISTS backing_grain;
ALTER TABLE public.entity_types DROP COLUMN IF EXISTS backing_sql;
