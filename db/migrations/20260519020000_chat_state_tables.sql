-- migrate:up

-- Chat SDK state-adapter backing tables, previously created at runtime by
-- `LobuStateAdapter.ensureSchema()` (packages/server/src/gateway/connections/
-- state-adapter.ts). Promoting them to a real migration so the canonical
-- schema source (db/schema.sql via dbmate) reflects production reality and
-- the CI drift gate stops failing whenever someone regenerates the snapshot
-- against a server-touched DB.
--
-- All five tables and four indexes are `IF NOT EXISTS` so this is a no-op
-- on any deployment that has already had the gateway boot — the runtime
-- ensureSchema() created the same shape with the same names and column
-- types. Schema is identical to `@chat-adapter/state-pg`'s (the upstream
-- library we replaced with in-house LobuStateAdapter; see the file header
-- on state-adapter.ts for why).

CREATE TABLE IF NOT EXISTS public.chat_state_subscriptions (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, thread_id)
);

CREATE TABLE IF NOT EXISTS public.chat_state_locks (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, thread_id)
);

CREATE TABLE IF NOT EXISTS public.chat_state_cache (
    key_prefix text NOT NULL,
    cache_key text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, cache_key)
);

CREATE TABLE IF NOT EXISTS public.chat_state_lists (
    key_prefix text NOT NULL,
    list_key text NOT NULL,
    seq bigserial NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone,
    PRIMARY KEY (key_prefix, list_key, seq)
);

CREATE TABLE IF NOT EXISTS public.chat_state_queues (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    seq bigserial NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (key_prefix, thread_id, seq)
);

CREATE INDEX IF NOT EXISTS chat_state_locks_expires_idx
    ON public.chat_state_locks (expires_at);

CREATE INDEX IF NOT EXISTS chat_state_cache_expires_idx
    ON public.chat_state_cache (expires_at);

CREATE INDEX IF NOT EXISTS chat_state_lists_expires_idx
    ON public.chat_state_lists (expires_at);

CREATE INDEX IF NOT EXISTS chat_state_queues_expires_idx
    ON public.chat_state_queues (expires_at);

-- migrate:down

DROP INDEX IF EXISTS public.chat_state_queues_expires_idx;
DROP INDEX IF EXISTS public.chat_state_lists_expires_idx;
DROP INDEX IF EXISTS public.chat_state_cache_expires_idx;
DROP INDEX IF EXISTS public.chat_state_locks_expires_idx;
DROP TABLE IF EXISTS public.chat_state_queues;
DROP TABLE IF EXISTS public.chat_state_lists;
DROP TABLE IF EXISTS public.chat_state_cache;
DROP TABLE IF EXISTS public.chat_state_locks;
DROP TABLE IF EXISTS public.chat_state_subscriptions;
