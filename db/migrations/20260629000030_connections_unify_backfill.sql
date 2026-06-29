-- migrate:up

-- Connections-unify Stage 1 (backfill), reuse-first: fold the two out-of-table
-- chat stores into `connections`, populating only EXISTING columns plus the one
-- new `credential_mode`. Fully IDEMPOTENT (guarded on the unique `slug`) and
-- NON-DESTRUCTIVE (agent_connections / app_installations stay the runtime source
-- of truth until the Stage 4 drop; this only materializes the unified
-- projection). NO runtime/store/UI cutover (Stage 2).
--
-- Column reuse:
--   connector_key      = platform ('slack' | 'telegram' | …)
--   external_tenant_id = the provider tenant id (Slack team_id); the
--                        one-active-chat-per-tenant index keys on it (new column).
--   config             = the adapter config (incl. the botToken secret:// ref) +
--                        folded { settings, chatMetadata } — no new settings /
--                        metadata columns.
--   app_auth_profile_id= the managed install's credential backing
--                        (app_installations.auth_profile_id; NULL for Slack today,
--                        whose token is the secret:// ref in config).
--   auth_profile_id    = the BYO connection's credential profile, when it had one.
--   agent_id           = the BYO row's owning agent; NULL for org-level managed.
--   credential_mode    = 'byo' | 'managed' (new column).
--   slug               = idempotency key: 'agentconn-'||id (byo) / external_id
--                        (managed). UNIQUE per org via connections_org_slug_unique.
--
-- Chat platforms ≔ the PlatformAdapterConfigSchema chat union minus 'webhook'
-- (ingest/data) and 'api'. GitHub/other app_installations are data/actions,
-- already represented as `connections` rows at install time, and are NOT folded.

-- ── Step 1: BYO chat connections (agent_connections) ────────────────────────
-- Done BEFORE the managed step so BYO wins a contended (org, platform, team).
-- BYO-wins / latest-wins: rank a tenant group by updated_at DESC; only rank 1
-- claims 'active' (the in-batch rank dedupes within one INSERT; the correlated
-- subquery additionally yields to any active chat row already present, for
-- re-run safety). Tenantless rows (Telegram, no teamId) skip the contest.
WITH src AS (
    SELECT
        ac.id,
        ac.organization_id,
        ac.agent_id,
        ac.platform,
        ac.config,
        ac.settings,
        ac.metadata,
        ac.created_at,
        ac.updated_at,
        NULLIF(ac.metadata ->> 'teamId', '') AS team_id,
        CASE ac.status
            WHEN 'active' THEN 'active'
            WHEN 'error' THEN 'error'
            ELSE 'paused'
        END AS mapped_status
    FROM public.agent_connections ac
    WHERE ac.platform IN ('slack', 'telegram', 'discord', 'whatsapp', 'teams', 'gchat')
      AND NOT EXISTS (
          SELECT 1 FROM public.connections c
          WHERE c.organization_id = ac.organization_id
            AND c.slug = 'agentconn-' || ac.id
            AND c.deleted_at IS NULL
      )
),
ranked AS (
    SELECT
        src.*,
        CASE
            WHEN team_id IS NOT NULL AND mapped_status = 'active'
            THEN ROW_NUMBER() OVER (
                PARTITION BY organization_id, platform, team_id
                ORDER BY updated_at DESC, id DESC
            )
            ELSE 1
        END AS active_rank
    FROM src
)
INSERT INTO public.connections (
    organization_id, connector_key, external_tenant_id, agent_id, display_name, status,
    config, credential_mode, slug, visibility, created_at, updated_at
)
SELECT
    r.organization_id,
    r.platform,
    r.team_id,
    r.agent_id,
    COALESCE(NULLIF(r.metadata ->> 'teamName', ''), r.platform),
    CASE
        WHEN r.mapped_status = 'active'
             AND r.active_rank = 1
             AND (
                 r.team_id IS NULL
                 OR NOT EXISTS (
                     SELECT 1 FROM public.connections c2
                     WHERE c2.organization_id = r.organization_id
                       AND c2.connector_key = r.platform
                       AND c2.external_tenant_id = r.team_id
                       AND c2.status = 'active'
                       AND c2.deleted_at IS NULL
                 )
             )
        THEN 'active'
        WHEN r.mapped_status = 'active' THEN 'paused'
        ELSE r.mapped_status
    END,
    -- Reuse `config`: keep the adapter config (incl. botToken ref) and fold
    -- settings + the residual metadata losslessly (so nothing is dropped before
    -- Stage 2 reads it). The tenant id lives in the external_tenant_id column.
    COALESCE(r.config, '{}'::jsonb)
        || jsonb_build_object('settings', r.settings, 'chatMetadata', r.metadata),
    'byo',
    'agentconn-' || r.id,
    'org',
    r.created_at,
    r.updated_at
FROM ranked r;

-- ── Step 2: managed Slack installs (app_installations) ──────────────────────
-- Runs AFTER step 1, so the active-row guard sees a BYO row already holding the
-- team's slot and demotes the managed row to 'paused' (BYO-wins, loser kept for
-- audit). external_id (slackinst-<uuid>) is preserved as slug + idempotency key.
WITH src AS (
    SELECT
        ai.id,
        ai.organization_id,
        ai.external_tenant_id AS team_id,
        ai.auth_profile_id,
        ai.metadata,
        ai.created_at,
        ai.updated_at,
        CASE ai.status
            WHEN 'active' THEN 'active'
            WHEN 'error' THEN 'error'
            ELSE 'paused'
        END AS mapped_status,
        COALESCE(NULLIF(ai.metadata ->> 'external_id', ''), 'slackinst-' || ai.id) AS ext_id
    FROM public.app_installations ai
    WHERE ai.provider = 'slack'
      AND NOT EXISTS (
          SELECT 1 FROM public.connections c
          WHERE c.organization_id = ai.organization_id
            AND c.slug = COALESCE(NULLIF(ai.metadata ->> 'external_id', ''), 'slackinst-' || ai.id)
            AND c.deleted_at IS NULL
      )
),
ranked AS (
    SELECT
        src.*,
        CASE
            WHEN mapped_status = 'active'
            THEN ROW_NUMBER() OVER (
                PARTITION BY organization_id, team_id
                ORDER BY updated_at DESC, id DESC
            )
            ELSE 1
        END AS active_rank
    FROM src
)
INSERT INTO public.connections (
    organization_id, connector_key, external_tenant_id, app_auth_profile_id, display_name, status,
    config, credential_mode, slug, visibility, created_at, updated_at
)
SELECT
    r.organization_id,
    'slack',
    r.team_id,
    r.auth_profile_id,
    COALESCE(NULLIF(r.metadata ->> 'team_name', ''), 'slack'),
    CASE
        WHEN r.mapped_status = 'active'
             AND r.active_rank = 1
             AND NOT EXISTS (
                 SELECT 1 FROM public.connections c2
                 WHERE c2.organization_id = r.organization_id
                   AND c2.connector_key = 'slack'
                   AND c2.external_tenant_id = r.team_id
                   AND c2.status = 'active'
                   AND c2.deleted_at IS NULL
             )
        THEN 'active'
        WHEN r.mapped_status = 'active' THEN 'paused'
        ELSE r.mapped_status
    END,
    COALESCE(r.metadata -> 'config', '{}'::jsonb)
        || jsonb_build_object('chatMetadata', r.metadata),
    'managed',
    r.ext_id,
    'org',
    r.created_at,
    r.updated_at
FROM ranked r;

-- ── Step 3: link existing bindings to the backfilled chat connection ────────
-- `credential_mode IS NOT NULL` identifies the backfilled chat connections.
-- Match an unlinked binding to the ACTIVE chat connection for its (org,
-- platform, team); tenantless bindings (Telegram) match on the source agent.
UPDATE public.agent_channel_bindings b
SET connection_id = (
    SELECT c.id FROM public.connections c
    WHERE c.deleted_at IS NULL
      AND c.status = 'active'
      AND c.credential_mode IS NOT NULL
      AND c.organization_id = b.organization_id
      AND c.connector_key = b.platform
      AND (
          (b.team_id IS NOT NULL AND c.external_tenant_id = b.team_id)
          OR (b.team_id IS NULL AND c.external_tenant_id IS NULL AND c.agent_id = b.agent_id)
      )
    ORDER BY c.updated_at DESC
    LIMIT 1
)
WHERE b.connection_id IS NULL
  AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.deleted_at IS NULL
        AND c.status = 'active'
        AND c.credential_mode IS NOT NULL
        AND c.organization_id = b.organization_id
        AND c.connector_key = b.platform
        AND (
            (b.team_id IS NOT NULL AND c.external_tenant_id = b.team_id)
            OR (b.team_id IS NULL AND c.external_tenant_id IS NULL AND c.agent_id = b.agent_id)
        )
  );

-- migrate:down

-- Unlink bindings that point at a backfilled chat connection, then remove the
-- backfilled chat rows. Best-effort dev rollback (source tables untouched).
UPDATE public.agent_channel_bindings
SET connection_id = NULL
WHERE connection_id IN (
    SELECT id FROM public.connections WHERE credential_mode IN ('byo', 'managed')
);

DELETE FROM public.connections
WHERE credential_mode IN ('byo', 'managed')
  AND (slug LIKE 'agentconn-%' OR slug LIKE 'slackinst-%');
