-- migrate:up

-- Add `oauth_broker` as a first-class auth_profiles.profile_kind. An
-- oauth_broker profile IS a broker descriptor: its auth_data holds the typed,
-- named fields broker_url / broker_org / broker_connection_id plus the PAT
-- (broker_pat). A broker-backed connection points its existing
-- app_auth_profile_id FK at an oauth_broker profile (instead of an oauth_app),
-- and the runtime fetches a fresh access token from the broker at execution
-- time. This replaces the prior `__broker` magic-key hack that smuggled a
-- broker ref inside an oauth_app profile's credential blob.
--
-- Postgres can't extend a CHECK in place, so drop the existing profile_kind
-- check and re-add it with `oauth_broker` appended to the value list.
ALTER TABLE auth_profiles
  DROP CONSTRAINT IF EXISTS auth_profiles_profile_kind_check;

ALTER TABLE auth_profiles
  ADD CONSTRAINT auth_profiles_profile_kind_check
  CHECK (profile_kind = ANY (ARRAY[
    'env'::text,
    'oauth_app'::text,
    'oauth_account'::text,
    'browser_session'::text,
    'interactive'::text,
    'oauth_broker'::text
  ]));

-- migrate:down

-- Revert to the original value list (without `oauth_broker`). Any oauth_broker
-- rows must be removed first or the re-ADD will fail; rolling back this
-- migration is only valid before the feature ships rows in prod.
ALTER TABLE auth_profiles
  DROP CONSTRAINT IF EXISTS auth_profiles_profile_kind_check;

ALTER TABLE auth_profiles
  ADD CONSTRAINT auth_profiles_profile_kind_check
  CHECK (profile_kind = ANY (ARRAY[
    'env'::text,
    'oauth_app'::text,
    'oauth_account'::text,
    'browser_session'::text,
    'interactive'::text
  ]));
