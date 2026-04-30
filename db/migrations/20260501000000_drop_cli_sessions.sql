-- migrate:up

-- The bespoke `lobu login` device-code flow that backed `cli_sessions` has
-- been replaced with standard OAuth 2.0 device-code (issued by the existing
-- Owletto IdP). The CLI now mints OAuth bearer tokens, so `cli_sessions` is
-- dead.
DROP INDEX IF EXISTS public.cli_sessions_user_id_idx;
DROP INDEX IF EXISTS public.cli_sessions_expires_at_idx;
DROP TABLE IF EXISTS public.cli_sessions;

-- migrate:down

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
