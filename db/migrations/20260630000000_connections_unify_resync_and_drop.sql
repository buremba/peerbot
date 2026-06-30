-- migrate:up

-- ════════ Connections-unify: deploy-time re-sync + DROP agent_connections ════════
-- FINAL contract phase. The code cutover in this PR makes `connections` the SOLE
-- source of truth for chat (reads AND writes); no code path reads or writes
-- `agent_connections` anymore. This migration runs in a MAINTENANCE WINDOW (app
-- pods drained, no concurrent writes), so at migration time `agent_connections`
-- is a FROZEN, complete snapshot of every BYO chat connection.
--
-- Why a full re-sync (not just insert-missing): the Stage-1 backfill
-- (20260629000030) already materialized `connections`, but old pods kept writing
-- `agent_connections` AFTER that snapshot, so the projection is now STALE (missing
-- rows created since, stale config/status on edited rows, orphan rows for
-- connections deleted in legacy). We converge `connections` to mirror the frozen
-- legacy truth exactly, then drop the legacy table.
--
-- Scope: ONLY BYO chat (`agentconn-<id>` rows). Managed Slack installs live in
-- `app_installations` (`slackinst-` rows) — a different table, not retired here —
-- so they are left untouched except where a managed row must yield the
-- one-active-per-tenant slot to a now-active BYO sibling (Step 2, mirrors the
-- Stage-1 BYO-wins rule + the runtime demote in upsertChatConnectionProjection).

-- ── Step 1: prune orphans — BYO projection rows whose legacy source was deleted
-- (hard-deleted in agent_connections by old code after the Stage-1 backfill).
-- MUST run BEFORE the upsert: an ACTIVE orphan for (org, platform, team) still
-- occupies the `connections_active_chat_tenant` slot, so inserting the new
-- ACTIVE BYO row for the same tenant in Step 3 would trip the partial unique
-- index. Pruning here frees the slot first.
UPDATE public.connections c
SET deleted_at = now(), updated_at = now()
WHERE c.credential_mode = 'byo'
  AND c.slug LIKE 'agentconn-%'
  AND c.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_connections ac
      WHERE 'agentconn-' || ac.id = c.slug
        AND ac.organization_id = c.organization_id
  );

-- ── Step 2: yield the active-tenant slot — demote any managed install whose ──
-- (org, platform, team) now has an ACTIVE BYO agent_connections row, so the
-- Step 3 upsert can activate the BYO projection without tripping the partial
-- unique index `connections_active_chat_tenant`. (agent_connections is
-- unique-per-(org, team) for Slack via idx_agent_connections_slack_workspace, so
-- there is no BYO-vs-BYO contest; only BYO-vs-managed needs resolving.)
UPDATE public.connections c
SET status = 'paused', updated_at = now()
WHERE c.credential_mode = 'managed'
  AND c.status = 'active'
  AND c.deleted_at IS NULL
  AND c.external_tenant_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM public.agent_connections ac
      WHERE ac.platform = c.connector_key
        AND ac.organization_id = c.organization_id
        AND NULLIF(ac.metadata ->> 'teamId', '') = c.external_tenant_id
        AND ac.status = 'active'
  );

-- ── Step 3: upsert EVERY agent_connections row from the frozen legacy snapshot ──
-- slug = 'agentconn-'||id keys the projection 1:1 to its agent_connections row.
-- NO platform filter: agent_connections only ever held chat-store connections
-- (the AgentConnectionStore's rows), and ALL of them — including the #1235
-- `platform='webhook'` ingest connections and any `api` rows — are resolved at
-- runtime via getConnection (credential_mode IS NOT NULL). The Stage-1 backfill's
-- chat-only allowlist EXCLUDED webhook/api, which the Stage-2a legacy-read
-- fallback masked; with the fallback and the table both gone, those rows must be
-- projected here or they would vanish on the drop. ON CONFLICT updates
-- config/status/agent_id/metadata so any drift since Stage-1 converges. Status
-- maps stopped/* → paused, error → error, active → active (Step 1 already cleared
-- the only contention).
INSERT INTO public.connections (
    organization_id, connector_key, external_tenant_id, agent_id, display_name,
    status, config, credential_mode, slug, visibility, error_message,
    created_at, updated_at
)
SELECT
    ac.organization_id,
    ac.platform,
    NULLIF(ac.metadata ->> 'teamId', ''),
    ac.agent_id,
    COALESCE(NULLIF(ac.metadata ->> 'teamName', ''), ac.platform),
    CASE ac.status
        WHEN 'active' THEN 'active'
        WHEN 'error' THEN 'error'
        ELSE 'paused'
    END,
    COALESCE(ac.config, '{}'::jsonb)
        || jsonb_build_object('settings', ac.settings, 'chatMetadata', ac.metadata),
    'byo',
    'agentconn-' || ac.id,
    'org',
    ac.error_message,
    ac.created_at,
    ac.updated_at
FROM public.agent_connections ac
ON CONFLICT (organization_id, slug) WHERE deleted_at IS NULL DO UPDATE SET
    connector_key = EXCLUDED.connector_key,
    external_tenant_id = EXCLUDED.external_tenant_id,
    agent_id = EXCLUDED.agent_id,
    display_name = EXCLUDED.display_name,
    status = EXCLUDED.status,
    config = EXCLUDED.config,
    error_message = EXCLUDED.error_message,
    updated_at = EXCLUDED.updated_at;

-- ── Step 4: link any still-unlinked bindings to their backfilled chat connection
-- (re-run of Stage-1 Step 3 for bindings created since). `credential_mode IS NOT
-- NULL` identifies chat connections; tenantless bindings (Telegram) match on the
-- source agent.
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

-- ── Step 5: drop the legacy table. No FK references it (its only FK is outbound
-- to agents); agent_channel_bindings.connection_id references `connections`, not
-- this table. The table's own indexes (incl. uniq_preview_connection_per_platform,
-- whose invariant is re-established on `connections` in the next migration) drop
-- with it.
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.agent_connections;

-- migrate:down

-- Best-effort rollback: recreate the legacy table shell (matches the baseline
-- shape) so a rollback past this migration restores the schema. It comes back
-- EMPTY — `connections` remains the source of truth, and a real rollback would
-- also revert the consuming code in this PR.
CREATE TABLE IF NOT EXISTS public.agent_connections (
    id text NOT NULL,
    agent_id text NOT NULL,
    platform text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id text NOT NULL,
    CONSTRAINT agent_connections_pkey PRIMARY KEY (id),
    CONSTRAINT agent_connections_status_check
        CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text, 'error'::text]))),
    CONSTRAINT agent_connections_org_agent_fkey
        FOREIGN KEY (organization_id, agent_id)
        REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS agent_connections_agent_id_idx
    ON public.agent_connections USING btree (agent_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS agent_connections_org_agent_idx
    ON public.agent_connections USING btree (organization_id, agent_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS agent_connections_platform_idx
    ON public.agent_connections USING btree (platform);
