-- migrate:up
ALTER TABLE mcp_sessions
  ADD COLUMN IF NOT EXISTS supports_mcp_apps boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN mcp_sessions.supports_mcp_apps IS
  'Whether the client negotiated the MCP Apps UI extension for this session';

-- migrate:down
ALTER TABLE mcp_sessions
  DROP COLUMN IF EXISTS supports_mcp_apps;
