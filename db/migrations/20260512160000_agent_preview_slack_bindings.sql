-- migrate:up

CREATE TABLE IF NOT EXISTS public.agent_preview_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL REFERENCES public."organization"(id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    created_by text REFERENCES public."user"(id) ON DELETE SET NULL,
    provider text NOT NULL DEFAULT 'lobu-public-slack',
    code_hash text NOT NULL UNIQUE,
    code_prefix text NOT NULL,
    allowed_surfaces text[] NOT NULL DEFAULT ARRAY['dm']::text[],
    local_relay_session_id text,
    expires_at timestamptz NOT NULL,
    claimed_at timestamptz,
    claimed_by_external jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_preview_claims_provider_check CHECK (provider = 'lobu-public-slack'),
    CONSTRAINT agent_preview_claims_allowed_surfaces_check CHECK (
        allowed_surfaces <@ ARRAY['dm', 'channel', 'thread']::text[]
    )
);

CREATE INDEX IF NOT EXISTS agent_preview_claims_org_agent_idx
    ON public.agent_preview_claims (organization_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_preview_claims_expires_idx
    ON public.agent_preview_claims (expires_at)
    WHERE claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.agent_preview_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL REFERENCES public."organization"(id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    created_by text REFERENCES public."user"(id) ON DELETE SET NULL,
    claim_id uuid REFERENCES public.agent_preview_claims(id) ON DELETE SET NULL,
    provider text NOT NULL DEFAULT 'lobu-public-slack',
    surface_type text NOT NULL,
    external_team_id text NOT NULL,
    external_user_id text,
    external_channel_id text NOT NULL,
    external_thread_ts text,
    surface_key text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_preview_bindings_provider_check CHECK (provider = 'lobu-public-slack'),
    CONSTRAINT agent_preview_bindings_surface_type_check CHECK (surface_type = ANY (ARRAY['dm', 'channel', 'thread']::text[])),
    CONSTRAINT agent_preview_bindings_status_check CHECK (status = ANY (ARRAY['active', 'revoked']::text[])),
    CONSTRAINT agent_preview_bindings_thread_shape_check CHECK (
        (surface_type = 'thread' AND external_thread_ts IS NOT NULL)
        OR (surface_type <> 'thread' AND external_thread_ts IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS agent_preview_bindings_org_agent_idx
    ON public.agent_preview_bindings (organization_id, agent_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS agent_preview_bindings_surface_live_idx
    ON public.agent_preview_bindings (provider, external_team_id, surface_key)
    WHERE status = 'active';

-- migrate:down

DROP INDEX IF EXISTS public.agent_preview_bindings_surface_live_idx;
DROP INDEX IF EXISTS public.agent_preview_bindings_org_agent_idx;
DROP TABLE IF EXISTS public.agent_preview_bindings;
DROP INDEX IF EXISTS public.agent_preview_claims_expires_idx;
DROP INDEX IF EXISTS public.agent_preview_claims_org_agent_idx;
DROP TABLE IF EXISTS public.agent_preview_claims;
