-- migrate:up

-- Companion heal for the CONCURRENTLY build in 20260719120000 (see that file).
-- Drops only an INVALID same-named carcass from a crashed concurrent build.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'channel_messages_org_dedup'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.channel_messages_org_dedup';
  END IF;
END
$migration$;

-- migrate:down

SELECT 1;
