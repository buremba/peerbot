-- migrate:up

-- Contract phase of the is_workspace_agent / workspace_id removal.
--
-- The columns were superseded by organization.system_agent_id and made dead in
-- a prior release (lobu#1405): no code across server, core, agent-worker, cli,
-- or the owletto frontend reads or writes them anymore. That release is fully
-- deployed, so dropping the columns now is safe under a rolling upgrade — no
-- running replica references them. They are NOT in the query_sql table-schema
-- allowlist (packages/server/src/utils/table-schema.ts), so no scoped CTE emits
-- them and this needs no two-phase expand/contract beyond the code-first split
-- already shipped. DROP COLUMN is an O(1) catalog flip under a brief ACCESS
-- EXCLUSIVE lock — no table rewrite for these types.

ALTER TABLE public.agents DROP COLUMN IF EXISTS is_workspace_agent;
ALTER TABLE public.agents DROP COLUMN IF EXISTS workspace_id;

-- migrate:down

ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS is_workspace_agent boolean DEFAULT false;
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS workspace_id text;
