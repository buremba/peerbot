-- migrate:up

-- Per-agent display toggle: render the agent's tool invocations (name + args +
-- result) as cards in the web chat. Off by default — tool internals are noise
-- for most end users, so this is opt-in. Mirrors the existing `verbose_logging`
-- boolean column (nullable, constant default → no table rewrite, squawk-safe).
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS show_tool_calls boolean DEFAULT false;

COMMENT ON COLUMN public.agents.show_tool_calls IS
    'Render the agent''s tool invocations as cards in the web chat. Gates both the live tool_use stream and the persisted tool-call blocks rebuilt on reload.';

-- migrate:down

ALTER TABLE public.agents DROP COLUMN IF EXISTS show_tool_calls;
