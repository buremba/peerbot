-- migrate:up

-- Companion heal for the CONCURRENTLY builds in 20260721120020/120030 (see
-- those files). Drops only an INVALID same-named carcass left by a crashed
-- concurrent build so the IF NOT EXISTS build can run again.

DO $migration$
DECLARE
  idx text;
BEGIN
  FOREACH idx IN ARRAY ARRAY[
    'connector_versions_org_key_version',
    'connector_versions_shared_key_version'
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = idx
        AND NOT i.indisvalid
    ) THEN
      EXECUTE format('DROP INDEX public.%I', idx);
    END IF;
  END LOOP;
END
$migration$;

-- migrate:down

SELECT 1;
