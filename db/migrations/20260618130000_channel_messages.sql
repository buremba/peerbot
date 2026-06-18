-- migrate:up

-- Durable chat transcript: the messages a connection has seen in its channels,
-- captured from the real-time event stream (NOT the throttled platform history
-- API). This is the read backend for the `read_conversation` tool — cheap,
-- connection-scoped, queryable by channel + time. It is deliberately NOT the
-- `events` knowledge store: chat transcript is high-volume operational data we
-- want the OPTION to prune/delete on demand (compliance), which the append-only
-- `events` table forbids. Messages worth remembering are PROMOTED into `events`
-- separately (the agent's save_memory tool / watcher distillation), keeping the
-- knowledge store curated. No retention policy today — keep everything; the
-- table just makes on-demand deletion possible.
--
-- UNIQUE(connection_id, channel_id, platform_message_id) makes capture
-- idempotent: webhook redeliveries and the bot's own echoed posts collapse to a
-- single row. (The hot read index is added CONCURRENTLY in the next migration.)
CREATE TABLE IF NOT EXISTS public.channel_messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id text NOT NULL,
    connection_id text NOT NULL,
    platform text NOT NULL,
    channel_id text NOT NULL,
    thread_id text,
    platform_message_id text NOT NULL,
    author_id text,
    author_name text,
    is_bot boolean NOT NULL DEFAULT false,
    text text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_messages_dedup UNIQUE (connection_id, channel_id, platform_message_id)
);

-- migrate:down

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.channel_messages;
