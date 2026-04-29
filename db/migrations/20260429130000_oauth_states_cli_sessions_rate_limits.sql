-- migrate:up

-- Phase 7 of Redis -> Postgres migration: replace the three remaining
-- ephemeral-key Redis stores (OAuth state CSRF nonces, CLI auth sessions,
-- and the fixed-window rate limiter) with thin Postgres tables. None of
-- these need cross-process pub/sub or pipelining; they're cheap row-level
-- reads/writes with a TTL column for lazy cleanup on read plus a periodic
-- vacuum task.
--
-- Design notes:
--   - All three tables key on a text id and store an explicit `expires_at`.
--     Lazy reads filter `expires_at > now()`; a background sweeper deletes
--     stale rows in bulk.
--   - `payload` is jsonb so the OAuth state stores can keep their schema
--     flexible (PKCE verifier, redirect URI, MCP discovery context, etc.)
--     without churning migrations.
--   - The rate_limits table is a single counter per (key, window_started_at)
--     instead of one row per request — the existing Redis impl is a fixed
--     window with INCR + EXPIRE, so a counter row matches the semantics
--     exactly.

-- OAuth state nonces: provider PKCE flows, MCP OAuth flow, Slack install,
-- CLI browser/device handoff. `scope` mirrors the Redis key-prefix
-- (e.g. `claude:oauth_state`, `mcp-oauth:state`, `slack:oauth:state`,
-- `cli:auth:request`) so a single lookup tagged by scope+id replaces the
-- previous prefix+id Redis lookup.
CREATE TABLE IF NOT EXISTS public.oauth_states (
    id text PRIMARY KEY,
    scope text NOT NULL,
    payload jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_states_scope_idx
    ON public.oauth_states (scope);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx
    ON public.oauth_states (expires_at);

-- CLI auth sessions for the `lobu` CLI. Each row is a long-lived (30 day)
-- refresh-token-anchored session; the access token is JWT-shaped and
-- carries `sessionId` so verifyAccessToken can re-check the row exists
-- and hasn't been revoked.
CREATE TABLE IF NOT EXISTS public.cli_sessions (
    session_id text PRIMARY KEY,
    user_id text NOT NULL,
    email text,
    name text,
    refresh_token_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cli_sessions_user_id_idx
    ON public.cli_sessions (user_id);

CREATE INDEX IF NOT EXISTS cli_sessions_expires_at_idx
    ON public.cli_sessions (expires_at);

-- Fixed-window rate limit counters. One row per (key, window_started_at);
-- a successful consume() does an UPSERT that increments `count`, sets the
-- window if missing, and returns the new count. The window expires when
-- `expires_at <= now()`.
--
-- `key` is the same string the Redis impl used (`rate-limit:cli:admin-login:<ip>`,
-- etc) so callers don't have to translate.
CREATE TABLE IF NOT EXISTS public.rate_limits (
    key text PRIMARY KEY,
    count integer NOT NULL DEFAULT 0,
    window_started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_expires_at_idx
    ON public.rate_limits (expires_at);

-- migrate:down

DROP TABLE IF EXISTS public.rate_limits;
DROP TABLE IF EXISTS public.cli_sessions;
DROP TABLE IF EXISTS public.oauth_states;
