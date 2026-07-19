-- migrate:up transaction:false

-- A hosted preview connection can route one physical message to Behaviors in
-- several organizations. Build the organization-scoped arbiter before retiring
-- the old global one so new replicas can durably capture one authorized copy per
-- organization without ever leaving transcript writes without uniqueness.
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
      AND c.relname = 'channel_messages_org_dedup'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.channel_messages_org_dedup';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_messages_org_dedup
  ON public.channel_messages (
    organization_id,
    connection_id,
    channel_id,
    platform_message_id
  );

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.channel_messages_org_dedup;
