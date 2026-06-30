-- migrate:up

-- One-shot, server-proven onboarding intents emitted by auth hooks.
-- Used to carry facts that only the server can know reliably (for example,
-- "this request just created a new user via provider X") across the auth
-- callback -> SPA redirect boundary. Intents are short-lived and consumed
-- before the client performs the suggested onboarding action, so returning
-- users are never redirected based on weak heuristics like "no connections".

CREATE TABLE IF NOT EXISTS public.auth_onboarding_intents (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    kind text NOT NULL,
    provider text,
    connector_key text,
    action text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);

-- New empty table — non-concurrent index builds block nothing.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS auth_onboarding_intents_pending_user_idx
    ON public.auth_onboarding_intents (user_id, kind, created_at)
    WHERE consumed_at IS NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS auth_onboarding_intents_expires_idx
    ON public.auth_onboarding_intents (expires_at);

-- One pending new-user marker is enough; the account hook consumes it and turns
-- it into a concrete action intent when the signup provider maps to one.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS auth_onboarding_new_user_pending_uniq
    ON public.auth_onboarding_intents (user_id, kind)
    WHERE consumed_at IS NULL AND kind = 'new_user_signup';

-- Do not enqueue duplicate pending install actions for the same connector.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS auth_onboarding_install_pending_uniq
    ON public.auth_onboarding_intents (user_id, action, connector_key)
    WHERE consumed_at IS NULL AND action = 'install_app';

-- migrate:down

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.auth_onboarding_intents;
