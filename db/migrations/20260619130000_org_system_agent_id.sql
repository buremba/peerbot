-- migrate:up

-- Per-org pointer to the org's "system" agent — the builder/console agent that
-- backs the org-management surface. This is a server-controlled pointer only:
-- the sole writer is manage_agents.set_system_agent (plus default-org
-- provisioning); it is never set by ordinary agent CRUD.
--
-- No FK to public.agents: agent ids are NOT globally unique — agents has a
-- composite PK (organization_id, id), so a single-column FK can't reference it.
-- This is an app-level pointer scoped by the row's own organization_id; the
-- writer (set_system_agent) verifies the target agent exists in this org before
-- updating, and manage_agents.delete refuses to drop the agent it points at.
--
-- Additive nullable ADD COLUMN: rolling-deploy safe (old replicas ignore the
-- column, new replicas treat NULL as "no system agent"), so there's no
-- expand/contract concern.
ALTER TABLE public.organization ADD COLUMN IF NOT EXISTS system_agent_id text;

COMMENT ON COLUMN public.organization.system_agent_id IS 'Per-org pointer to the builder/console (system) agent (agents.id within this org). Server-controlled only — written exclusively by manage_agents.set_system_agent and default-org provisioning, never by ordinary agent CRUD. No FK because agents has a composite PK (organization_id, id); this is an app-level, org-scoped pointer.';

-- migrate:down

ALTER TABLE public.organization DROP COLUMN IF EXISTS system_agent_id;
