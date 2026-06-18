-- migrate:up transaction:false

-- The read_conversation query: most-recent N messages in a channel, fenced to
-- (organization_id, connection_id, channel_id) and ordered by occurred_at DESC.
-- The index mirrors that exactly — the three equality predicates first, then
-- occurred_at DESC — so the planner serves the LIMIT from an ordered index range
-- scan instead of scanning the whole channel and sorting (the table has no
-- retention, so a busy channel grows unbounded). thread_id is deliberately NOT
-- indexed: read_conversation is channel-level today, and slotting thread_id
-- between channel_id and occurred_at would break the ordered scan. Add a
-- thread-scoped index when thread-level reads land. CONCURRENTLY so the build
-- never blocks capture writes; one statement per transaction:false migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_channel_messages_read
    ON public.channel_messages (organization_id, connection_id, channel_id, occurred_at DESC);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_channel_messages_read;
