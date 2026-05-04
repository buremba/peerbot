-- migrate:up

-- Flatten the agents table: there is no longer a template/sandbox split.
-- One agents row = one logical agent. Definitions, providers, settings all
-- live on this row and are agent-only (not per-user).
--
-- Per-user state has its own homes:
--   - user_auth_profiles (per-user-per-agent OAuth tokens) — already canonical
--   - agent_channel_bindings (where the agent operates)
--   - agent_users (who has interacted)
--
-- ROLLOUT NOTE: this migration deletes every sandbox row. There is no
-- pre-cutover production data to preserve (per buremba). If that ever
-- changes, the rollback below restores the columns but NOT the deleted
-- rows.

-- 1. Drop sandbox rows. Anything with template_agent_id or parent_connection_id
--    set was a per-user / per-connection sandbox.
DELETE FROM public.agents
WHERE template_agent_id IS NOT NULL
   OR parent_connection_id IS NOT NULL;

-- 2. Drop indexes on the going-away columns.
DROP INDEX IF EXISTS public.agents_template_agent_id_idx;
DROP INDEX IF EXISTS public.agents_parent_connection_id_idx;

-- 3. Drop the columns themselves.
ALTER TABLE public.agents DROP COLUMN IF EXISTS template_agent_id;
ALTER TABLE public.agents DROP COLUMN IF EXISTS parent_connection_id;

-- 4. Drop legacy / dead-code columns.
--    auth_profiles: superseded by user_auth_profiles table (per-user-per-agent).
--    mcp_install_notified: per-user UI dismissal state, never used at runtime.
ALTER TABLE public.agents DROP COLUMN IF EXISTS auth_profiles;
ALTER TABLE public.agents DROP COLUMN IF EXISTS mcp_install_notified;

-- migrate:down

-- Restore columns (data is gone — the DELETE is irreversible).
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS template_agent_id text;
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS parent_connection_id text;
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS auth_profiles jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS mcp_install_notified jsonb DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS agents_template_agent_id_idx
    ON public.agents (template_agent_id);
CREATE INDEX IF NOT EXISTS agents_parent_connection_id_idx
    ON public.agents (parent_connection_id);
