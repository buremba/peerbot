-- migrate:up

-- Adds the 'auth' run lifecycle: workers run interactive connector.authenticate()
-- flows (WhatsApp QR, OAuth redirect, credential prompt) and stream artifacts
-- back to the UI via runs.checkpoint. The UI signals back (OAuth callback,
-- form submit, cancel) via runs.auth_signal.

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
        'sync'::text,
        'action'::text,
        'code'::text,
        'insight'::text,
        'watcher'::text,
        'embed_backfill'::text,
        'auth'::text
    ])
);

-- Target auth profile for 'auth' runs (null for other run types).
ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS auth_profile_id bigint
    REFERENCES public.auth_profiles(id) ON DELETE CASCADE;

-- Reverse channel: UI → connector. The connector pauses on ctx.awaitSignal(name)
-- and polls this column; the API writes here when the UI posts a signal.
ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS auth_signal jsonb;

-- One active auth run per auth profile at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_auth_per_profile
    ON public.runs (auth_profile_id)
    WHERE run_type = 'auth'
      AND auth_profile_id IS NOT NULL
      AND status = ANY (ARRAY['pending'::text, 'claimed'::text, 'running'::text]);

-- 'interactive' profile kind: credentials produced by a connector.authenticate()
-- run. Examples: WhatsApp Baileys session, connector-managed OAuth.
ALTER TABLE public.auth_profiles DROP CONSTRAINT IF EXISTS auth_profiles_profile_kind_check;
ALTER TABLE public.auth_profiles ADD CONSTRAINT auth_profiles_profile_kind_check CHECK (
    profile_kind = ANY (ARRAY[
        'env'::text,
        'oauth_app'::text,
        'oauth_account'::text,
        'browser_session'::text,
        'interactive'::text
    ])
);

-- Structured display metadata produced by connector.authenticate() — account_id,
-- display_name, paired_at, expires_at, etc. Surfaced in UI next to the connection.
ALTER TABLE public.auth_profiles ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb NOT NULL;


-- migrate:down

ALTER TABLE public.auth_profiles DROP COLUMN IF EXISTS metadata;

ALTER TABLE public.auth_profiles DROP CONSTRAINT IF EXISTS auth_profiles_profile_kind_check;
ALTER TABLE public.auth_profiles ADD CONSTRAINT auth_profiles_profile_kind_check CHECK (
    profile_kind = ANY (ARRAY[
        'env'::text,
        'oauth_app'::text,
        'oauth_account'::text,
        'browser_session'::text
    ])
);

DROP INDEX IF EXISTS public.idx_runs_active_auth_per_profile;

ALTER TABLE public.runs DROP COLUMN IF EXISTS auth_signal;
ALTER TABLE public.runs DROP COLUMN IF EXISTS auth_profile_id;

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
        'sync'::text,
        'action'::text,
        'code'::text,
        'insight'::text,
        'watcher'::text,
        'embed_backfill'::text
    ])
);
