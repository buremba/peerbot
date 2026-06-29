-- migrate:up
ALTER TABLE public.agents DROP COLUMN IF EXISTS mcp_servers;

-- migrate:down
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS mcp_servers jsonb DEFAULT '{}'::jsonb;
