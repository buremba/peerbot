-- migrate:up transaction:false

-- Partial BTREE on events.metadata->>'x_user_id'. X connector events already
-- stamp immutable author/counterparty ids through legacy entityLinks; the
-- canonical identity namespace registry now marks x_user_id as event-recall
-- indexed, so content-search emits a UNION branch for it. Without this index
-- that branch would seq-scan the append-only events table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_metadata_x_user_id
    ON public.events (((metadata ->> 'x_user_id'::text)))
    WHERE (metadata ? 'x_user_id'::text);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_metadata_x_user_id;
