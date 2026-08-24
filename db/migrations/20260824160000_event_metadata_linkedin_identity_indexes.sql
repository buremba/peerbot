-- migrate:up transaction:false

-- LinkedIn attribution stamps the normalized vanity slug and, where Voyager
-- exposes it, immutable member id onto event metadata. Partial BTREE indexes
-- let person-scoped recall probe those append-only events without a table scan.
-- Heal INVALID same-named carcasses inline so an interrupted concurrent build
-- is repaired on retry before IF NOT EXISTS evaluates the catalog entry.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_events_metadata_linkedin_slug'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_metadata_linkedin_slug';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_metadata_linkedin_slug
    ON public.events (((metadata ->> 'linkedin_slug'::text)))
    WHERE (metadata ? 'linkedin_slug'::text);

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_events_metadata_linkedin_member_id'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_metadata_linkedin_member_id';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_metadata_linkedin_member_id
    ON public.events (((metadata ->> 'linkedin_member_id'::text)))
    WHERE (metadata ? 'linkedin_member_id'::text);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_metadata_linkedin_member_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_metadata_linkedin_slug;
