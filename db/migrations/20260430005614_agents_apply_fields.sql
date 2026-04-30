-- migrate:up

-- Persist three agent settings fields that the file-loader produces from
-- lobu.toml but the postgres-backed AgentConfigStore had nowhere to put:
--   * egress_config       -> AgentSettings.egressConfig
--   * pre_approved_tools  -> AgentSettings.preApprovedTools
--   * guardrails          -> AgentSettings.guardrails
-- Without these columns, `lobu apply` would silently drop the values on
-- every push, producing perpetual drift between local and cloud.

ALTER TABLE public.agents
  ADD COLUMN egress_config jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN pre_approved_tools jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN guardrails jsonb DEFAULT '[]'::jsonb;

-- migrate:down

ALTER TABLE public.agents
  DROP COLUMN egress_config,
  DROP COLUMN pre_approved_tools,
  DROP COLUMN guardrails;
