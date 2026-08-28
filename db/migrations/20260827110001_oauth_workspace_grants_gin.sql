-- migrate:up transaction:false

-- Companion to 20260827110000_oauth_workspace_grants.sql. Keep the hot token
-- table available while adding the per-workspace connected-app lookup index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_tokens_granted_organization_ids_idx
  ON public.oauth_tokens USING gin (granted_organization_ids);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.oauth_tokens_granted_organization_ids_idx;
