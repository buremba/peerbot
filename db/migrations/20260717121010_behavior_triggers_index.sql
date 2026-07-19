-- migrate:up transaction:false

-- Event activation uses a coarse @> lookup before applying exact connector,
-- connection, event-type, and match filters in code. Build the supporting GIN
-- index without blocking writes to existing Behavior rows.
--
-- Two statements (heal DO + CREATE INDEX CONCURRENTLY). dbmate historically
-- Exec'd the whole up section as one simple-query batch, and Postgres wraps
-- multi-statement batches in an implicit transaction that CONCURRENTLY refuses.
-- transaction:false ups that include CONCURRENTLY must therefore be executed
-- statement-at-a-time (packages/server/src/db/migration-loader.ts + callers;
-- docker/app/start.sh migrate path).
--
-- 1) Drop an INVALID leftover of the same name. If a prior CONCURRENTLY build
--    crashed, IF NOT EXISTS would match the carcass by name and skip forever
--    while the planner ignores the invalid index. Plain DROP (not CONCURRENTLY)
--    of an INVALID index is safe: invalid indexes serve no queries, so the
--    lock is brief metadata-only. DROP INDEX CONCURRENTLY cannot run inside a
--    DO block and cannot filter on indisvalid.
-- 2) CREATE INDEX CONCURRENTLY IF NOT EXISTS — rebuilds after a heal, no-ops
--    when a valid index already exists.

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

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_watchers_triggers_gin
  ON watchers USING gin (triggers jsonb_path_ops)
  WHERE status = 'active' AND triggers <> '[]'::jsonb;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_watchers_triggers_gin;
