-- migrate:up transaction:false

-- Re-establish the single-hosted-preview-per-platform invariant on `connections`.
-- The legacy `uniq_preview_connection_per_platform` index (on agent_connections)
-- dropped with that table in the previous migration. `resolveBoundChannelRows`
-- branch B (and the inbound getBindingAnyOrg path) still trusts a connection
-- marked `config.settings.previewMode = true` with no tenant to serve bindings
-- ACROSS orgs — only safe if there is exactly ONE such connection per platform,
-- else cross-org resolution is ambiguous (which hosted bot posts?). The Stage-1
-- backfill folded `settings` into `config.settings` and `teamId` into
-- `external_tenant_id`, so the predicate moves to those.
--
-- CONCURRENTLY (transaction:false) so the build never blocks writes; prod carries
-- exactly one matching row today, so the build won't hit a duplicate.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_preview_connection_per_platform_conn
    ON public.connections (connector_key)
    WHERE config -> 'settings' -> 'previewMode' = 'true'::jsonb
      AND external_tenant_id IS NULL
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.uniq_preview_connection_per_platform_conn;
