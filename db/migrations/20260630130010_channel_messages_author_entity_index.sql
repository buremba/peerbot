-- migrate:up transaction:false

-- Lookup index for per-author transcript queries (e.g. "what did <person> say").
-- Partial on NOT NULL so the index stays small while most rows (bot posts,
-- unattributed) carry no author. CONCURRENTLY (transaction:false, one statement)
-- so building it never locks the high-write channel_messages table. Separate
-- migration from the column add — squawk requires a CONCURRENTLY index alone in
-- its own file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_channel_messages_author_entity
  ON public.channel_messages (author_entity_id)
  WHERE author_entity_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_channel_messages_author_entity;
