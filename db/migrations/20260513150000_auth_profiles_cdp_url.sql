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

-- migrate:down

ALTER TABLE public.auth_profiles
    DROP COLUMN IF EXISTS cdp_url;
