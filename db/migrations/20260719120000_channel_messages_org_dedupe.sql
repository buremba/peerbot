-- migrate:up transaction:false

-- A hosted preview connection can route one physical message to Behaviors in
-- several organizations. Build the organization-scoped arbiter before retiring
-- the old global one so new replicas can durably capture one authorized copy per
-- organization without ever leaving transcript writes without uniqueness.
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
