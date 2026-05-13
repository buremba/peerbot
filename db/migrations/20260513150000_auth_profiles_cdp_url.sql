-- migrate:up

-- Add `cdp_url` to auth_profiles. For a device-bound `browser_session`
-- profile, exactly one of {user_data_dir, cdp_url} should be set:
--   user_data_dir  → managed Chrome with isolated cookies (default)
--   cdp_url        → attach to a running Chrome via remote-debugging-port
-- The application enforces this invariant; we don't add a CHECK constraint
-- because the OR-on-NULL semantics are awkward to express and the column
-- is harmless when both are NULL (legacy fleet path with cookies in
-- auth_data jsonb).

ALTER TABLE public.auth_profiles
    ADD COLUMN IF NOT EXISTS cdp_url text;

-- A device-bound browser_session profile MUST set exactly one of
-- (user_data_dir, cdp_url). Other profile kinds — and non-device-bound
-- browser_session profiles (cookies in auth_data, fleet-served) — are
-- exempt. Enforcing this at the DB stops a buggy admin tool or a bad
-- merge from setting both and then having the connector silently prefer
-- whichever code path it sees first.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_device_browser_path_xor'
    ) THEN
        ALTER TABLE public.auth_profiles
            ADD CONSTRAINT auth_profiles_device_browser_path_xor
            CHECK (
                device_worker_id IS NULL
                OR profile_kind <> 'browser_session'
                OR (
                    (user_data_dir IS NOT NULL AND cdp_url IS NULL)
                    OR (user_data_dir IS NULL AND cdp_url IS NOT NULL)
                )
            );
    END IF;
END$$;

-- migrate:down

ALTER TABLE public.auth_profiles
    DROP CONSTRAINT IF EXISTS auth_profiles_device_browser_path_xor,
    DROP COLUMN IF EXISTS cdp_url;
