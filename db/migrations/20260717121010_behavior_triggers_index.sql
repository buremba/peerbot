-- migrate:up transaction:false

-- Event activation uses a coarse @> lookup before applying exact connector,
-- connection, event-type, and match filters in code. Build the supporting GIN
-- index without blocking writes to existing Behavior rows.
--
-- IF NOT EXISTS does not repair an INVALID same-named index left by an
-- interrupted concurrent build. Drop only that carcass before rebuilding;
-- the migration runners execute this DO separately from CREATE CONCURRENTLY.

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

-- Partial predicate is status-only. `triggers <> '[]'` is unprovable from the
-- activation `@>` lookup, so the planner would never use this index with that
-- extra clause. Empty trigger arrays still fail `@>` and are harmless.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_watchers_triggers_gin
  ON watchers USING gin (triggers jsonb_path_ops)
  WHERE status = 'active';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_watchers_triggers_gin;
