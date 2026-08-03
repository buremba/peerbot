-- migrate:up
-- MCP registrations are Connected Apps, not agent assignments. Remove the
-- obsolete display hint once; future activity writes no longer recreate it.
UPDATE public.oauth_clients
SET metadata = metadata - 'last_agent_id',
    updated_at = now()
WHERE metadata ? 'last_agent_id';

-- migrate:down
-- The obsolete hint cannot be reconstructed reliably.
