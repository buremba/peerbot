-- migrate:up
-- Drop the two legacy per-agent model-selection columns. Model choice is now a
-- single `agents.model` ref (the agent's defaultModel — a `provider/model`
-- string or "auto"), resolved through the layered fallback
-- behavior → agent → org default. The backfill migration
-- (20260704000010_backfill_agent_default_model) already folded any pinned /
-- preference value into `agents.model` BEFORE this drop, so no live model
-- selection is lost. `installed_providers` is KEPT (it is now purely the
-- credential/catalog list, not a model-resolution input).
ALTER TABLE agents DROP COLUMN IF EXISTS model_selection;
ALTER TABLE agents DROP COLUMN IF EXISTS provider_model_preferences;

-- migrate:down
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_selection jsonb DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider_model_preferences jsonb DEFAULT '{}'::jsonb;
