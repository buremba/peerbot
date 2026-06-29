-- migrate:up

-- Connections-unify Stage 1 (expand), reuse-first. `connections` is ALREADY the
-- intended unified table (its baseline comment: "Replaces the legacy
-- chat_connections + per-platform tables"; lists Slack/Telegram/GitHub/Linear)
-- and already has the slots chat needs — connector_key (platform), config (adapter
-- config + secret:// refs), auth_profile_id / app_auth_profile_id (credential
-- backing), agent_id, status, visibility, slug. `app_installations` +
-- `agent_connections` are parallel duplicates added later. So we do NOT add a
-- faceted column set; we FINISH folding chat into `connections`, reusing columns.
--
-- TWO genuinely-new columns:
--   external_tenant_id — the provider workspace/tenant id (Slack team_id, …). A
--     first-class routing + uniqueness key: Stage-2 Slack routing queries it on
--     the hot path and the one-active-chat-per-tenant invariant keys on it, so it
--     gets a real indexed column (mirroring app_installations.external_tenant_id +
--     app_installations_active_tenant), not a jsonb expression. NULL for
--     tenantless chat (Telegram) and for data connectors.
--   credential_mode (managed | byo) — for chat the bot token is a secret:// ref in
--     `config` for BOTH modes and auth_profile_id / app_auth_profile_id are NULL,
--     so neither auth slot distinguishes a Lobu-hosted OAuth install (managed)
--     from a customer-supplied token (byo). Deriving it from `agent_id IS NULL`
--     would overload agent_id and mislabel a future org-level BYO connection, so
--     it is stored explicitly. NULL for data connectors (which use auth_profiles),
--     so `credential_mode IS NOT NULL` also reads as "this is a chat connection".
--
-- Capabilities/facets are DERIVED, not stored (Data=feeds, Chat=bindings,
-- Actions=operations/MCP, Audience=authz_source_acl_state). settings/metadata
-- fold into `config` / `display_name` / `slug` (see the backfill).

ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS external_tenant_id text,
    ADD COLUMN IF NOT EXISTS credential_mode text;

-- credential_mode domain. DROP-IF-EXISTS keeps the ADD re-runnable; NOT VALID
-- avoids a scan-lock (the column is brand-new/all-NULL so VALIDATE is instant).
ALTER TABLE public.connections DROP CONSTRAINT IF EXISTS connections_credential_mode_check;
ALTER TABLE public.connections
    ADD CONSTRAINT connections_credential_mode_check
    CHECK (credential_mode IS NULL OR credential_mode IN ('managed', 'byo')) NOT VALID;
ALTER TABLE public.connections VALIDATE CONSTRAINT connections_credential_mode_check;

-- Bindings gain a connection_id FK (nullable, secondary in Stage 1 — bindings
-- still route by (platform, team_id) until Stage 3). ON DELETE SET NULL: deleting
-- a connection must NOT cascade-delete bindings yet. NOT VALID then VALIDATE so
-- the FK build doesn't lock both tables at prod scale.
ALTER TABLE public.agent_channel_bindings
    ADD COLUMN IF NOT EXISTS connection_id bigint;
ALTER TABLE public.agent_channel_bindings
    DROP CONSTRAINT IF EXISTS agent_channel_bindings_connection_id_fkey;
ALTER TABLE public.agent_channel_bindings
    ADD CONSTRAINT agent_channel_bindings_connection_id_fkey
    FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.agent_channel_bindings VALIDATE CONSTRAINT agent_channel_bindings_connection_id_fkey;

-- migrate:down

ALTER TABLE public.agent_channel_bindings
    DROP CONSTRAINT IF EXISTS agent_channel_bindings_connection_id_fkey;
ALTER TABLE public.agent_channel_bindings
    DROP COLUMN IF EXISTS connection_id;

ALTER TABLE public.connections
    DROP CONSTRAINT IF EXISTS connections_credential_mode_check;
ALTER TABLE public.connections
    DROP COLUMN IF EXISTS credential_mode,
    DROP COLUMN IF EXISTS external_tenant_id;
