-- migrate:up transaction:false

-- Restore the GLOBAL-unique runtime-connection-id invariant for chat.
--
-- The retired `agent_connections.id` was the table's PRIMARY KEY — unique across
-- ALL organizations. Orgless runtime paths depend on that: the public webhook URL
-- `/api/v1/webhooks/:connectionId`, exclusive-transport restart, and the
-- connection-claims lease all resolve a connection by its runtime id ALONE, with
-- no org in hand. After the unify cutover a chat connection is keyed by
-- `(organization_id, slug)`, which is only unique PER ORG — so an orgless lookup
-- by slug could match two tenants' rows and route to the wrong one.
--
-- This partial unique index re-establishes the prior guarantee at the slug level:
-- at most one LIVE chat connection (credential_mode set, not soft-deleted) may own
-- a given slug across the whole table, so the orgless lookups are unambiguous
-- again. Data connectors (credential_mode NULL) keep org-scoped slugs and are
-- excluded; a soft-deleted row frees its slug for re-creation.
--
-- The backfill preserved the old globally-unique ids verbatim into the slug
-- (`agentconn-<id>` / `slackinst-<uuid>`), so existing rows already satisfy this —
-- CONCURRENTLY (transaction:false) so the build never blocks writes, and it fails
-- loudly (before the window completes) if any pre-existing cross-org duplicate
-- slipped in, rather than silently routing wrong.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS connections_chat_slug_unique
    ON public.connections (slug)
    WHERE credential_mode IS NOT NULL AND deleted_at IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.connections_chat_slug_unique;
