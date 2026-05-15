-- migrate:up
-- Admin-managed default app profile per (org, connector_key).
-- Today getPrimaryAuthProfileForKind picks the most-recently-updated active
-- oauth_app profile for the connector — admins have no way to designate
-- which profile members should fall through to. The flag lets the admin
-- pin a chosen profile; the resolver prefers flagged rows first.
--
-- Constrained to oauth_app for now since that's the only kind where
-- "default for connector" is meaningful (env / interactive / browser_session
-- are picked by other rules — device binding, capture mode, etc.).

ALTER TABLE auth_profiles
  ADD COLUMN is_default_for_connector boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX auth_profiles_default_for_connector_unique
  ON auth_profiles (organization_id, connector_key)
  WHERE is_default_for_connector AND profile_kind = 'oauth_app';

-- migrate:down
DROP INDEX IF EXISTS auth_profiles_default_for_connector_unique;

ALTER TABLE auth_profiles
  DROP COLUMN IF EXISTS is_default_for_connector;
