-- migrate:up
-- Relax the device-binding XOR constraint to allow mirror mode (where
-- neither user_data_dir nor cdp_url is set on the row — the source dir
-- info lives in auth_data.source_profile_dir / source_browser_root).
--
-- Before mirror mode there were two ways to back a browser_session
-- profile: a Lobu-owned managed --user-data-dir (column user_data_dir) or
-- a CDP endpoint Lobu attaches to (column cdp_url). The old constraint
-- enforced exactly one of those. Mirror mode adds a third path: the auth
-- profile points to one of the user's own Chrome profiles, Lobu decrypts
-- cookies on demand at sync time, and no Chrome instance is ever launched
-- by Lobu. For mirror profiles both columns are NULL by design.
--
-- We replace the XOR with "at most one of (user_data_dir, cdp_url) is
-- set, never both" — i.e. the mutual-exclusion half of the original
-- constraint is kept, the "exactly one" requirement is dropped. Mirror
-- profiles satisfy by setting neither; the existing two modes by setting
-- one. Application-level validation in worker-api.ts continues to enforce
-- "exactly one of {mirror, cdp, legacy} per create" so we don't
-- accidentally create unusable rows.

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
