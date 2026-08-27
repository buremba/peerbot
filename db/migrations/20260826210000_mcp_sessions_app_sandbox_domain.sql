-- migrate:up
ALTER TABLE mcp_sessions
  ADD COLUMN IF NOT EXISTS supports_app_sandbox_domain boolean;

COMMENT ON COLUMN mcp_sessions.supports_app_sandbox_domain IS
  'Whether this MCP session advertised the OpenAI visibility capability used to gate App sandbox-domain metadata; NULL marks rows written before this capability was persisted';

-- migrate:down
ALTER TABLE mcp_sessions
  DROP COLUMN IF EXISTS supports_app_sandbox_domain;
