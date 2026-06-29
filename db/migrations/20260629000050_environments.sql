-- migrate:up

-- A named, configured execution environment an agent runs in. An environment
-- binds a runtime provider (vercel | cloudflare | e2b | daytona) to an org's
-- vault credential and (later) per-environment config. The `builtin` runtime
-- and `device` environments are NOT rows — builtin is synthetic and devices are
-- projected from `device_workers` — so this table holds only provider-backed
-- sandbox environments.
--
-- `config` is an intentionally-empty jsonb home for per-environment knobs
-- (egress policy, resources, runtime image, region) so those can be added
-- additively without a schema change. The credential itself is never stored
-- here — only `credential_name`, the `agent_secrets` row name
-- (`environment:<id>:<field>`); resolution stays gateway-side.
CREATE TABLE IF NOT EXISTS public.environments (
    id text NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    -- Runtime provider kind; matches a registered GatewayRuntimeProvider id.
    provider_kind text NOT NULL,
    -- 'org' (shared) | 'private' (owner-only). owner_user_id is set iff private.
    scope text NOT NULL DEFAULT 'org',
    owner_user_id text,
    -- agent_secrets row-name prefix backing this environment's credential; NULL
    -- until a credential is set. Never holds ciphertext.
    credential_name text,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT environments_pkey PRIMARY KEY (id),
    CONSTRAINT environments_provider_kind_check
        CHECK (provider_kind IN ('vercel', 'cloudflare', 'e2b', 'daytona')),
    CONSTRAINT environments_scope_check CHECK (scope IN ('org', 'private')),
    -- The (organization_id, name) unique index also serves org-scoped lookups
    -- (organization_id is the leading column), so no separate org index.
    CONSTRAINT environments_org_name_key UNIQUE (organization_id, name)
);

-- migrate:down

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.environments;
