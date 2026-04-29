-- migrate:up

-- Enforce tenant scope on connection.auth_profile FKs.
--
-- Background: connections.app_auth_profile_id and connections.auth_profile_id
-- referenced auth_profiles(id) without checking that the profile belongs to
-- the same organization as the connection. A bug in some prior create path
-- left at least one connection (id=212, org buremba) pointing at an auth
-- profile in a different org (id=10, org_617e78013e6ff72d). The UI correctly
-- refused to load it ("Auth profile 'reddit-oauth-app' not found"), but the
-- bad reference blocked setup.
--
-- Fix: switch both FKs to multi-column (organization_id, profile_id) so
-- references can't escape their tenant. MATCH SIMPLE (the default) keeps
-- profile_id-NULL satisfying the constraint, which is what we want — the
-- column stays nullable.

-- 1. Clean up any cross-org or dangling references in existing data.
--    Idempotent: 0 rows once applied; safe to re-run.
UPDATE connections c
SET app_auth_profile_id = NULL, updated_at = NOW()
WHERE app_auth_profile_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth_profiles ap
    WHERE ap.id = c.app_auth_profile_id
      AND ap.organization_id = c.organization_id
  );

UPDATE connections c
SET auth_profile_id = NULL, updated_at = NOW()
WHERE auth_profile_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth_profiles ap
    WHERE ap.id = c.auth_profile_id
      AND ap.organization_id = c.organization_id
  );

-- 2. Add (organization_id, id) UNIQUE on auth_profiles to give the new FK a
--    target. Cheap on the existing 31-row table.
ALTER TABLE auth_profiles
    ADD CONSTRAINT auth_profiles_org_id_unique UNIQUE (organization_id, id);

-- 3. Replace single-column FKs with tenant-scoped multi-column FKs.
ALTER TABLE connections
    DROP CONSTRAINT connections_app_auth_profile_id_fkey;
ALTER TABLE connections
    ADD CONSTRAINT connections_app_auth_profile_id_fkey
    FOREIGN KEY (organization_id, app_auth_profile_id)
    REFERENCES auth_profiles (organization_id, id)
    ON DELETE SET NULL;

ALTER TABLE connections
    DROP CONSTRAINT connections_auth_profile_id_fkey;
ALTER TABLE connections
    ADD CONSTRAINT connections_auth_profile_id_fkey
    FOREIGN KEY (organization_id, auth_profile_id)
    REFERENCES auth_profiles (organization_id, id)
    ON DELETE SET NULL;

-- migrate:down

ALTER TABLE connections
    DROP CONSTRAINT connections_app_auth_profile_id_fkey;
ALTER TABLE connections
    ADD CONSTRAINT connections_app_auth_profile_id_fkey
    FOREIGN KEY (app_auth_profile_id)
    REFERENCES auth_profiles (id)
    ON DELETE SET NULL;

ALTER TABLE connections
    DROP CONSTRAINT connections_auth_profile_id_fkey;
ALTER TABLE connections
    ADD CONSTRAINT connections_auth_profile_id_fkey
    FOREIGN KEY (auth_profile_id)
    REFERENCES auth_profiles (id)
    ON DELETE SET NULL;

ALTER TABLE auth_profiles
    DROP CONSTRAINT auth_profiles_org_id_unique;
