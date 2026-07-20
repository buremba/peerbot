-- migrate:up

-- Companion heal for the CONCURRENTLY build in 20260717121010. `IF NOT EXISTS`
-- on CREATE INDEX CONCURRENTLY does not repair an INVALID same-named index left
-- by an interrupted concurrent build; drop only that carcass before rebuilding.
-- Runs in the default (transactional) migration so it stays a single dbmate
-- statement-batch; the CONCURRENTLY build is isolated in its own
-- transaction:false migration (dbmate sends a multi-statement transaction:false
-- body in one implicit transaction, which CONCURRENTLY rejects).

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_watchers_triggers_gin'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_watchers_triggers_gin';
  END IF;
END
$migration$;

-- migrate:down

SELECT 1;
