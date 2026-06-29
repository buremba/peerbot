-- migrate:up transaction:false

-- Lookup index for the new bindings.connection_id FK (Stage 3 will route
-- bindings by connection_id; Stage 1 backfills it). Partial on NOT NULL so the
-- index stays small while the column is still mostly unpopulated. CONCURRENTLY
-- (transaction:false, one statement) to avoid locking the bindings table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_channel_bindings_connection_id
    ON public.agent_channel_bindings (connection_id)
    WHERE connection_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_agent_channel_bindings_connection_id;
