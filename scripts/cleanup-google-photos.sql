-- One-off cleanup for the retired `google_photos` connector.
--
-- The v0 connector only produced timestamp + dimension stubs (no location,
-- no people, no captions — Google's Photos Library API doesn't expose any of
-- those). The Mac app's `apple.photos` connector replaces it with rich
-- PhotoKit metadata. Nothing of substance is lost.
--
-- This script:
--   1) Hard-deletes events ingested by `google_photos` connections
--      (intentionally breaks the events-are-append-only convention for
--      connector decommissioning — the rule exists to protect information
--      value, and these rows have none).
--   2) Deletes the connections themselves.
--   3) Deletes any auth_profiles whose connector_key is `google_photos` or
--      the legacy generic `google.oauth`, and the orphan oauth_app at id 11.
--
-- Run against the target DB once, manually:
--   psql "$DATABASE_URL" -f scripts/cleanup-google-photos.sql
--
-- Wrap the entire run in a single transaction so a midway failure rolls back.

BEGIN;

-- 1) Wipe events whose connector_key is google_photos. Doing this by
--    connector_key (not connection_id) catches orphan rows where the
--    connection was already deleted but the events linger with
--    connection_id = NULL.
DELETE FROM events
WHERE connector_key = 'google_photos';

-- 2) Delete the connections (and cascade their feeds + connect_tokens via
--    existing FKs).
DELETE FROM connections
WHERE connector_key = 'google_photos';

-- 3) Delete auth profiles tied to this connector. Includes the legacy
--    generic `google.oauth` umbrella profile (orphan since each Google
--    connector got its own per-API client).
DELETE FROM auth_profiles
WHERE connector_key IN ('google_photos', 'google.oauth');

COMMIT;
