-- migrate:up

-- Personal-credential connections must NEVER be org-visible.
--
-- A connection reads through ONE org-level credential (its auth profile's
-- token), not a per-reader credential. So an `org`-visible connection backed by
-- a personal login (`auth_profiles.profile_kind = 'oauth_account'` — a user's
-- own Gmail/calendar/etc.) exposes that user's private data to every org member
-- through the owner's token. The application now defaults/floors such
-- connections to `private` at every write path, but this is the hard backstop:
--   (1) backfill any pre-existing org-visible personal connection to private;
--   (2) a trigger that REJECTS any INSERT/UPDATE leaving an oauth_account
--       connection at visibility='org' — so no code path (tool, API, or raw
--       SQL) can ever re-widen one.

-- (1) Backfill. Idempotent: only touches rows that are currently wrong.
UPDATE connections c
SET visibility = 'private',
    updated_at = NOW()
FROM auth_profiles ap
WHERE ap.id = c.auth_profile_id
  AND ap.profile_kind = 'oauth_account'
  AND c.visibility = 'org'
  AND c.deleted_at IS NULL;

-- (2) Guard trigger. Fires only when auth_profile_id or visibility is set to a
-- non-null/relevant value, and only raises for the forbidden combination, so it
-- adds no cost to the common case. A NULL auth_profile_id (no credential yet,
-- e.g. a pending OAuth connect) is allowed at 'org' — there is no personal token
-- to read through until a profile is attached, and the attach itself re-fires
-- this trigger.
CREATE OR REPLACE FUNCTION public.assert_personal_cred_not_org_visible()
RETURNS trigger AS $$
BEGIN
  IF NEW.visibility = 'org' AND NEW.auth_profile_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.auth_profiles ap
      WHERE ap.id = NEW.auth_profile_id
        AND ap.profile_kind = 'oauth_account'
    ) THEN
      RAISE EXCEPTION
        'connection %: a personal-credential (oauth_account) connection cannot be org-visible; set visibility to private',
        COALESCE(NEW.id::text, '(new)')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DROP first so the migration is re-runnable: the embedded runtime applies the
-- SQL and writes the schema_migrations ledger row in two separate statements, so
-- a crash between them replays this file on next boot — a bare CREATE TRIGGER
-- would then fail 42710 and wedge boot.
DROP TRIGGER IF EXISTS connections_personal_cred_visibility_guard ON public.connections;
CREATE TRIGGER connections_personal_cred_visibility_guard
  BEFORE INSERT OR UPDATE OF visibility, auth_profile_id ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_personal_cred_not_org_visible();

-- migrate:down

DROP TRIGGER IF EXISTS connections_personal_cred_visibility_guard ON public.connections;
DROP FUNCTION IF EXISTS public.assert_personal_cred_not_org_visible();
-- The backfill is not reversed: re-widening personal connections to 'org' is the
-- exposure this migration exists to prevent.
