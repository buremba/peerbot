-- migrate:up transaction:false

-- The read_conversation query: most-recent N messages in a channel (and
-- optionally a thread), connection-scoped. CONCURRENTLY so the build never
-- blocks capture writes; one statement per transaction:false migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_channel_messages_read
    ON public.channel_messages (connection_id, channel_id, thread_id, occurred_at DESC);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_channel_messages_read;
