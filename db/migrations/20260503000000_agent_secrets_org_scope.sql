-- migrate:up

-- agent_secrets used a global `(name)` namespace, so two organizations
-- storing the same key (e.g. `ANTHROPIC_API_KEY`) would silently overwrite
-- each other. Scope rows by organization while keeping legacy rows
-- addressable: empty-string organization_id means "global" (used by
-- system env-store and any pre-existing rows from the global era).

ALTER TABLE public.agent_secrets
    ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT '';

ALTER TABLE public.agent_secrets
    DROP CONSTRAINT IF EXISTS agent_secrets_pkey;

ALTER TABLE public.agent_secrets
    ADD CONSTRAINT agent_secrets_pkey PRIMARY KEY (organization_id, name);

CREATE INDEX IF NOT EXISTS agent_secrets_org_id_idx
    ON public.agent_secrets (organization_id);

-- migrate:down

ALTER TABLE public.agent_secrets
    DROP CONSTRAINT IF EXISTS agent_secrets_pkey;

DROP INDEX IF EXISTS public.agent_secrets_org_id_idx;

DELETE FROM public.agent_secrets a
USING public.agent_secrets b
WHERE a.name = b.name
  AND a.organization_id <> ''
  AND b.organization_id = '';

DELETE FROM public.agent_secrets a
USING public.agent_secrets b
WHERE a.name = b.name
  AND a.organization_id > b.organization_id;

ALTER TABLE public.agent_secrets
    ADD CONSTRAINT agent_secrets_pkey PRIMARY KEY (name);

ALTER TABLE public.agent_secrets
    DROP COLUMN IF EXISTS organization_id;
