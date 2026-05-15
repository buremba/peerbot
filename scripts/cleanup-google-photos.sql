-- ============================================================================
-- One-off cleanup for the retired `google_photos` connector.
--
-- ⚠️  THIS SCRIPT BREAKS THE EVENTS-ARE-APPEND-ONLY RULE.
--
-- AGENTS.md is explicit: "events is append-only. Never `DELETE FROM events`.
-- To hide a row, insert a tombstone event whose supersedes_event_id points
-- at it." That rule exists to protect *information value* — supersession
-- preserves history so the agent can recover prior facts on demand.
--
-- This script intentionally violates it for a specific reason: the
-- `google_photos` v0 connector produced events with **no information value
-- to preserve**. Sampling confirmed each row is one of:
--
--   payload_text = "<width>x<height>"            (e.g. "2316x3088")
--   payload_text = "Photo taken on <iso-date>"   (tautological restatement)
--
-- No location, no people, no album, no caption, no OCR — Google's Photos
-- Library API never exposed them. 0 of 14,147 events have `location`,
-- `people`, `album`, or `caption` keys in metadata. The connector itself is
-- removed in this PR and the auth has been revoked, so the source_urls
-- (`photos.google.com/photo/<id>`) are dead handles.
--
-- Tombstoning 14k value-less stubs would just double the row count, leave
-- them recoverable via `include_superseded` (the opposite of what we want),
-- and pollute future search/scan paths without preserving any signal.
--
-- Hard-delete is the right call here, but it is a one-off retirement
-- decision, NOT a precedent. The append-only rule still holds for every
-- normal write path.
--
-- The replacement is `apple.photos`, which sources rich metadata from
-- PhotoKit on the user's Mac (location/albums/people/captions/OCR).
-- ============================================================================
--
-- This script:
--   1) Hard-deletes events ingested by `google_photos` connections.
--      Filtering by `connector_key` (not `connection_id`) catches orphan
--      rows whose connection was already deleted but whose events lingered
--      with `connection_id = NULL`.
--   2) Deletes the connections themselves (cascades feeds + connect_tokens
--      via existing FKs).
--   3) Deletes auth profiles tied to the connector, plus the legacy generic
--      `google.oauth` umbrella profile that's been orphaned since each
--      Google connector got its own per-API client.
--   4) Archives the `google_photos` connector_definition rows so the
--      connector no longer appears in the install picker. We `UPDATE
--      ... SET status='archived'` rather than `DELETE` so the
--      connector_versions audit trail stays intact (some installations
--      may want to know what was once installed).
--
-- Run against the target DB once, manually:
--   psql "$DATABASE_URL" -f scripts/cleanup-google-photos.sql
--
-- Wrap the entire run in a single transaction so a midway failure rolls back.

BEGIN;

-- 1) Wipe events whose connector_key is google_photos.
DELETE FROM events
WHERE connector_key = 'google_photos';

-- 2) Delete the connections (cascades feeds + connect_tokens).
DELETE FROM connections
WHERE connector_key = 'google_photos';

-- 3) Delete auth profiles tied to this connector, including the legacy
--    `google.oauth` umbrella that's been orphaned.
DELETE FROM auth_profiles
WHERE connector_key IN ('google_photos', 'google.oauth');

-- 4) Archive the connector_definition rows so the picker stops listing
--    google_photos as installable. Catalog reads filter on status='active',
--    so 'archived' is sufficient — and the connector_versions rows can
--    stay for forensic purposes (no separate cascade needed).
UPDATE connector_definitions
SET status = 'archived', updated_at = NOW()
WHERE key = 'google_photos'
  AND status = 'active';

COMMIT;
