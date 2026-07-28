-- migrate:up

-- What a CONNECTION of this connector contributes to the AGENT sandbox: nix
-- packages, credential-backed env vars, and egress domains (e.g. the GitHub
-- connector contributes `gh` + a leased GH_TOKEN + api.github.com).
--
-- Deliberately separate from `runtime`, which provisions the CONNECTOR WORKER's
-- own execution environment. The deployment resolver reads this column, never
-- connector code, so a connector's agent contribution is resolvable from the
-- database alone. NULL = contributes nothing.
ALTER TABLE public.connector_definitions
  ADD COLUMN IF NOT EXISTS agent_tooling jsonb;

-- migrate:down
-- squawk-ignore ban-drop-column -- rollback path for the column introduced here
ALTER TABLE public.connector_definitions
  DROP COLUMN IF EXISTS agent_tooling;
