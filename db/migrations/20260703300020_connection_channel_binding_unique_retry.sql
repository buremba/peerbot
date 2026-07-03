-- migrate:up transaction:false

-- Rebuild after the heal step (no-op when 20260703300000 succeeded — the valid
-- index already exists and IF NOT EXISTS skips). Same statement as the first
-- file; see there for design notes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_channel_bindings_connection_channel_unique
  ON public.agent_channel_bindings (organization_id, connection_id, channel_id);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.agent_channel_bindings_connection_channel_unique;
