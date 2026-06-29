-- migrate:up transaction:false

-- The one-active-chat-per-tenant invariant — the unified-model analogue of
-- `app_installations_active_tenant`, keyed on the first-class
-- `external_tenant_id` column and `connector_key` (the platform). At most ONE
-- active chat connection may own a given (org, platform, tenant): this is what
-- enforces BYO-vs-managed mutual exclusivity for a workspace (the Stage 1
-- backfill demotes the loser to 'paused'; Stage 2's runtime writes will rely on
-- this index the same way the Slack store relies on the app_installations index).
--
-- Partial: only chat connectors with a non-null tenant participate. Telegram (no
-- team) has external_tenant_id IS NULL and is excluded — it is keyed per
-- bot/connection, not per tenant. CONCURRENTLY (transaction:false, one
-- statement) so the build never blocks writes on a populated table.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS connections_active_chat_tenant
    ON public.connections (organization_id, connector_key, external_tenant_id)
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND external_tenant_id IS NOT NULL
      AND connector_key IN ('slack', 'telegram', 'discord', 'whatsapp', 'teams', 'gchat');

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.connections_active_chat_tenant;
