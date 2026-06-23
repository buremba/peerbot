-- migrate:up

-- Backfill existing Slack OAuth installs (slack_installations) into the generic
-- app_installations primitive. Part of the Slack consolidation (dual-write →
-- backfill → dual-read → deferred drop). Non-destructive: slack_installations is
-- left intact and stays the source of truth until the deferred contract drop.
--
-- Mapping (must match the runtime Slack adapter's dual-write exactly so reads
-- converge regardless of which path wrote the row):
--   provider           = 'slack'
--   provider_instance  = 'cloud'
--   provider_app_id    = 'cloud'              -- the single hosted Lobu Slack app
--   external_tenant_id = team_id              -- Slack routing key (no org context)
--   organization_id    = organization_id
--   status             = active|stopped|error -> active|suspended|error
--   auth_profile_id    = NULL                 -- Slack token is a secret:// ref in
--                                                metadata.config, not auth_profiles
--   metadata           = { external_id, team_name?, bot_user_id?, config }
--     external_id  = slack_installations.id (the stable slackinst-<uuid>;
--       it is the secret-store prefix + chat-instance-manager memo/routing key, so
--       it MUST be preserved across the consolidation)
--
-- Idempotent: an install already backfilled (matched by provider='slack' +
-- metadata->>'external_id' = the source id) is skipped via NOT EXISTS,
-- so re-running this migration (or running it after dual-write has already created
-- the row) inserts nothing.
--
-- Ownership invariant: app_installations_active_tenant forbids two ACTIVE rows for
-- the same (provider, provider_instance, provider_app_id, external_tenant_id). The
-- source table already enforces one active install per team (a fresh install from
-- another org demotes prior rows to 'stopped'), so the mapped 'active' rows are
-- already unique per team. We additionally guard against any historical duplicate
-- active row for a team by only inserting 'active' when no active row for that team
-- already exists in app_installations (the partial unique index would otherwise
-- abort the whole migration on a single dirty team).
INSERT INTO public.app_installations (
    organization_id,
    provider,
    provider_instance,
    provider_app_id,
    external_tenant_id,
    auth_profile_id,
    status,
    metadata,
    created_at,
    updated_at
)
SELECT
    si.organization_id,
    'slack',
    'cloud',
    'cloud',
    si.team_id,
    NULL,
    CASE si.status
        WHEN 'active' THEN 'active'
        WHEN 'stopped' THEN 'suspended'
        ELSE 'error'
    END,
    jsonb_strip_nulls(
        jsonb_build_object(
            'external_id', si.id,
            'team_name', si.team_name,
            'bot_user_id', si.bot_user_id,
            'config', si.config
        )
    ),
    si.created_at,
    si.updated_at
FROM public.slack_installations si
WHERE NOT EXISTS (
    SELECT 1 FROM public.app_installations ai
    WHERE ai.provider = 'slack'
      AND ai.metadata ->> 'external_id' = si.id
)
  -- Never create a second ACTIVE row for a team (would violate the active-tenant
  -- unique index). A stopped/error source row is always safe to insert.
  AND (
    si.status <> 'active'
    OR NOT EXISTS (
        SELECT 1 FROM public.app_installations ai2
        WHERE ai2.provider = 'slack'
          AND ai2.provider_instance = 'cloud'
          AND ai2.provider_app_id = 'cloud'
          AND ai2.external_tenant_id = si.team_id
          AND ai2.status = 'active'
    )
  );

-- migrate:down

-- Remove only the rows this backfill could have created (provider='slack' rows
-- carrying a external_id). Dual-written rows share the same shape, so
-- this is the inverse of the consolidation's app_installations Slack footprint.
DELETE FROM public.app_installations
WHERE provider = 'slack'
  AND metadata ? 'external_id';
