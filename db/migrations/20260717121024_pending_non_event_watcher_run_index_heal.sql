-- migrate:up

-- Companion heal for the CONCURRENTLY build in 20260717121025 (see that file).
-- Drops only an INVALID same-named carcass from a crashed concurrent build.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_runs_pending_non_event_watcher_per_watcher'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_runs_pending_non_event_watcher_per_watcher';
  END IF;
END
$migration$;

-- migrate:down

SELECT 1;
