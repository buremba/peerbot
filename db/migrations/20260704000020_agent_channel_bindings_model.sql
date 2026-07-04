-- migrate:up
-- Optional per-binding (Listen behavior) model override. A `provider/model`
-- ref (e.g. "claude/claude-sonnet-4-6") or "auto"; NULL means fall back to the
-- agent default, then the org default. Injected as baseOptions.model at inbound
-- message enqueue so it wins the layered fallback (behavior → agent → org).
ALTER TABLE agent_channel_bindings ADD COLUMN IF NOT EXISTS model text;

-- migrate:down
ALTER TABLE agent_channel_bindings DROP COLUMN IF EXISTS model;
