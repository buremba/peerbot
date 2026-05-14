-- migrate:up

-- Drop the NOT NULL on auth_profiles.connector_key so browser_session
-- profiles can be device-bound resources without a connector binding.
--
-- A browser_session profile is physically (device, browser_kind, user_data_dir
-- XOR cdp_url) — the connector_key was always a hint, not a gate. One CDP
-- attach on a Mac already has cookies for every site the user is logged into;
-- forcing one row per connector against the same cdp_url was bookkeeping for
-- the DB's benefit, not the user's. Connection resolution falls back to
-- "browser_session on the connection's device_worker_id" when no exact
-- connector match exists.
--
-- Other profile kinds (env, oauth_app, oauth_account, interactive) remain
-- per-connector; the new check constraint keeps them honest.

ALTER TABLE public.auth_profiles
    ALTER COLUMN connector_key DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_connector_key_required'
    ) THEN
        ALTER TABLE public.auth_profiles
            ADD CONSTRAINT auth_profiles_connector_key_required
            CHECK (
                connector_key IS NOT NULL
                OR profile_kind = 'browser_session'
            );
    END IF;
END$$;

-- migrate:down

ALTER TABLE public.auth_profiles
    DROP CONSTRAINT IF EXISTS auth_profiles_connector_key_required;

-- Restoring NOT NULL would fail if any browser_session rows now have
-- connector_key = NULL. Backfill with a placeholder before running this.
ALTER TABLE public.auth_profiles
    ALTER COLUMN connector_key SET NOT NULL;
