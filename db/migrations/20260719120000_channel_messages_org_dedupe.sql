-- migrate:up transaction:false

-- A hosted preview connection can route one physical message to Behaviors in
-- several organizations. Build the organization-scoped arbiter before retiring
-- the old global one so new replicas can durably capture one authorized copy per
-- organization without ever leaving transcript writes without uniqueness.
--
-- INVALID-carcass heal runs first in the companion migration
-- 20260719115959_channel_messages_org_dedupe_heal.sql. Single statement so
-- dbmate does not wrap CONCURRENTLY in an implicit transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_messages_org_dedup
  ON public.channel_messages (
    organization_id,
    connection_id,
    channel_id,
    platform_message_id
  );

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.channel_messages_org_dedup;
