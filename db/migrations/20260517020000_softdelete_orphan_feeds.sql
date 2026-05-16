-- migrate:up

-- Soft-delete feeds whose (connector_key, organization_id) has no active
-- connector_definition row.
--
-- Why: the 2026-05-16 audit found feeds 117-155 (and others) referencing
-- connector_key='website' in orgs that have no active definition for it
-- (only one org has `website` active; one definition is archived). Every
-- CheckDueFeeds tick (every minute) tried to materialize a sync run for
-- these feeds and threw "No active connector definition found for X." —
-- producing ~380 error logs / minute that masked real signal in stdout.
--
-- The app-side code path now warns + skips (no throw) for the same case
-- so future orphans don't spam logs either. This migration is the one-time
-- cleanup of the existing data.
--
-- Conservative criteria — only soft-delete when:
--   - feed has no pinned_version (= would have looked up connector_definitions)
--   - feed.deleted_at IS NULL (still considered active)
--   - the connection is still active (not already deleted)
--   - NO active connector_definition exists for that (key, organization) pair
--
-- The same feed remains recoverable: clearing `deleted_at` + reinstalling
-- the connector definition for the org restores it.

UPDATE public.feeds f
SET deleted_at = now()
FROM public.connections c
WHERE f.connection_id = c.id
  AND f.deleted_at IS NULL
  AND f.pinned_version IS NULL
  AND c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.connector_definitions cd
    WHERE cd.key = c.connector_key
      AND cd.organization_id = f.organization_id
      AND cd.status = 'active'
  );

-- migrate:down

-- No-op: re-attaching the orphan feeds would require knowing which were
-- soft-deleted by this migration vs. by an operator action. The original
-- error condition is fixed in code; this migration is a one-shot data
-- cleanup. To recover specific feeds in prod, clear `deleted_at` on the
-- targeted rows manually and re-install the connector definition.
