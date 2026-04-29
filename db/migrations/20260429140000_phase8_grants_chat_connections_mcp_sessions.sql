-- migrate:up

-- Phase 8 of Redis -> Postgres migration: replace the remaining Redis-only
-- substrates that don't fit cleanly into the existing tables with proper
-- typed Postgres tables.
--
-- 1. `grants` — per-(agent, kind, pattern) grant rows. Replaces the
--    `grant:<agentId>:<pattern>` Redis key prefix and SCAN-by-prefix list.
--    Wildcard expansion happens in the application layer.
-- 2. `chat_connections` — chat-platform (Telegram/Slack/Discord/...) connection
--    rows. Replaces the `connection:<id>`, `connections:all`, and
--    `connections:agent:<id>` Redis keys used by ChatInstanceManager. The
--    existing `public.connections` table is for Owletto product connectors,
--    not chat platforms.
-- 3. `mcp_proxy_sessions` — short-lived MCP server session-id mappings used
--    by the MCP proxy. The existing `public.mcp_sessions` table is the
--    inbound MCP-server-as-server session table; this is the outbound
--    upstream-MCP session-id cache.

-- ============================================================================
-- grants
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.grants (
    agent_id text NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    kind text NOT NULL,
    pattern text NOT NULL,
    expires_at timestamptz,
    granted_at timestamptz NOT NULL DEFAULT now(),
    denied boolean NOT NULL DEFAULT false,
    PRIMARY KEY (agent_id, kind, pattern)
);

CREATE INDEX IF NOT EXISTS grants_agent_id_idx
    ON public.grants (agent_id);

CREATE INDEX IF NOT EXISTS grants_expires_at_idx
    ON public.grants (expires_at)
    WHERE expires_at IS NOT NULL;

-- ============================================================================
-- chat_connections
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.chat_connections (
    id text PRIMARY KEY,
    platform text NOT NULL,
    template_agent_id text REFERENCES public.agents(id) ON DELETE CASCADE,
    config jsonb NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active',
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_connections_template_agent_id_idx
    ON public.chat_connections (template_agent_id)
    WHERE template_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_connections_platform_idx
    ON public.chat_connections (platform);

-- ============================================================================
-- mcp_proxy_sessions  (NOT to be confused with public.mcp_sessions which is
--                      the inbound MCP server's session table)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.mcp_proxy_sessions (
    session_key text PRIMARY KEY,
    upstream_session_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_proxy_sessions_expires_at_idx
    ON public.mcp_proxy_sessions (expires_at);

-- migrate:down

DROP TABLE IF EXISTS public.mcp_proxy_sessions;
DROP TABLE IF EXISTS public.chat_connections;
DROP TABLE IF EXISTS public.grants;
