-- migrate:up

-- The environment an agent runs in. References environments.id, or the literal
-- 'builtin'; NULL means default (builtin in-process / the deployment-wide
-- LOBU_RUNTIME_PROVIDER for self-host). Resolved to a runtime provider +
-- credential at worker-token mint time.
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS environment_id text;

-- migrate:down

ALTER TABLE public.agents
    DROP COLUMN IF EXISTS environment_id;
