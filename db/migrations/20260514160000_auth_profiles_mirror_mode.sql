-- migrate:up
-- Relax the device-binding XOR for browser_session profiles to allow
-- mirror mode, where neither user_data_dir nor cdp_url is set on the
-- row (the source profile dir lives in auth_data.source_profile_dir).
-- Keep the mutual exclusion of the two columns so they can't be set
-- together; application validation enforces "exactly one of mirror /
-- cdp / legacy" per row.

ALTER TABLE auth_profiles
  DROP CONSTRAINT IF EXISTS auth_profiles_device_browser_path_xor;

ALTER TABLE auth_profiles
  ADD CONSTRAINT auth_profiles_device_browser_path_mutex
  CHECK (
    device_worker_id IS NULL
    OR profile_kind <> 'browser_session'
    OR user_data_dir IS NULL
    OR cdp_url IS NULL
  );

-- migrate:down
ALTER TABLE auth_profiles
  DROP CONSTRAINT IF EXISTS auth_profiles_device_browser_path_mutex;

ALTER TABLE auth_profiles
  ADD CONSTRAINT auth_profiles_device_browser_path_xor
  CHECK (
    device_worker_id IS NULL
    OR profile_kind <> 'browser_session'
    OR ((user_data_dir IS NOT NULL) AND (cdp_url IS NULL))
    OR ((user_data_dir IS NULL) AND (cdp_url IS NOT NULL))
  );
