-- migrate:up

-- Config-authored starter chips for an agent's fresh-conversation view. When
-- set, they are served directly on the starters endpoint (no AI-generated
-- starters turn); empty/unset means the agent generates starters dynamically
-- from workspace state. Persisted as its own jsonb column on `agents` (agent
-- settings are per-field columns, mirrored by AgentSettingsStoredSchema and
-- postgres-stores rowToSettings/saveSettings — nesting into an existing blob
-- would break that contract).
--
-- Nullable, no default: existing rows read as NULL and use dynamic generation.
-- O(1) catalog add, no table rewrite.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS starter_prompts jsonb;

-- migrate:down

ALTER TABLE public.agents
  DROP COLUMN IF EXISTS starter_prompts;
