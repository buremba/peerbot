-- migrate:up

-- Per-binding response disposition for Listen behaviors:
--   'reply'  — the agent responds when @mentioned / DMed (the default, and the
--              behavior of every existing binding).
--   'silent' — the channel is ingested into memory but the agent never replies,
--              not even to an @mention (a watch-only "listen for context" channel).
-- Nullable with no default so this is an instant metadata-only change (no table
-- rewrite): a NULL disposition is read as 'reply' everywhere. Values are gated by
-- the manage_connections tool schema, so no DB CHECK constraint is needed.
ALTER TABLE public.agent_channel_bindings
    ADD COLUMN IF NOT EXISTS disposition text;

-- migrate:down

ALTER TABLE public.agent_channel_bindings
    DROP COLUMN IF EXISTS disposition;
