-- migrate:up

-- External-backed derived entity types. A derived entity type (backing_sql IS NOT
-- NULL) normally runs its view over Lobu's own org-scoped tables. When
-- backing_source references a connection, the view instead executes LIVE against
-- that connection's single external database (read-only, no copy) — see
-- query_entity_type + execute-external-source. NULL ⇒ internal (today's behavior).
-- backing_source is only meaningful on a derived type (backing_sql IS NOT NULL).
--
-- Deliberately NO foreign key to connections: if the source connection is deleted
-- the read must FAIL ("source connection no longer exists") rather than silently
-- fall back to internal scoping (ON DELETE SET NULL — which would run external SQL
-- against internal tables) or block connection deletion (ON DELETE RESTRICT).
-- query_entity_type validates the connection exists + is in-org at read time.
--
-- Stored as the connection SLUG (text), not an id: the slug is what the config
-- diff compares (no churn), it survives a connection delete+recreate, and
-- query_entity_type resolves slug → connection → DATABASE_URL fresh at read time.
--
-- Idempotent: no-op on databases that already have the column.
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS backing_source text;

-- migrate:down

ALTER TABLE public.entity_types DROP COLUMN IF EXISTS backing_source;
