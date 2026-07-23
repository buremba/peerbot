-- Backfill the Grid enterprise id onto Slack connection projections, and retire
-- stale org-wide (`E…`-keyed) connections that a later per-workspace reinstall
-- orphaned.
--
-- An ORG-WIDE Grid install returns no `team` from oauth.v2.access, so its
-- connection was keyed on the enterprise `E…` id. A later PER-WORKSPACE reinstall
-- arrives under a `T…` key and mints a NEW connection; the projection's
-- exact-tenant demote could not recognize an orphaned `E…` row as the superseded
-- generation, so it was left live (its streaming feed stranded — the damage
-- #2157 cleaned and #2163 stopped recurring on the feed side).
--
-- The code fix (persist `enterpriseId` onto the connection + enterprise-sibling
-- supersede in the projection) prevents new orphans. This migration makes the
-- invariant true for EXISTING rows:
--   1. Backfill `chatMetadata.enterpriseId` / `isEnterpriseInstall` from each
--      connection's backing `app_installations` row, so the projection can match
--      the enterprise on the next reinstall.
--   2. Retire any LIVE orphaned org-wide (`E…`-keyed) connection with no active
--      backing install that is superseded by a live per-workspace (`T…`)
--      connection of the same enterprise and org. Scoped to Slack managed rows.
--      The retire fires
--      `retire_streaming_feeds_for_deleted_connection` (#2163), reclaiming feeds.

-- migrate:up

-- 1. Backfill enterprise metadata onto connection projections from their install.
--    `metadata->>'external_id'` on the install is the connection slug.
UPDATE connections c
-- Merge onto the existing chatMetadata object (creating it when absent).
-- `jsonb_set` alone cannot create the intermediate `chatMetadata` key, so build
-- the whole sub-object with `||` and set it in one shot.
SET config = jsonb_set(
      COALESCE(c.config, '{}'::jsonb),
      '{chatMetadata}',
      COALESCE(c.config->'chatMetadata', '{}'::jsonb)
        || jsonb_build_object(
             'enterpriseId', ai.metadata->>'enterprise_id',
             'isEnterpriseInstall',
             COALESCE((ai.metadata->>'is_enterprise_install') = 'true', false)
           ),
      true
    ),
    updated_at = now()
FROM app_installations ai
WHERE ai.provider = 'slack'
  AND ai.metadata->>'external_id' = c.slug
  AND ai.metadata->>'enterprise_id' IS NOT NULL
  AND c.connector_key = 'slack'
  AND c.credential_mode = 'managed'
  AND (
    (c.config->'chatMetadata'->>'enterpriseId') IS DISTINCT FROM (ai.metadata->>'enterprise_id')
    OR (c.config->'chatMetadata'->>'isEnterpriseInstall') IS DISTINCT FROM
       CASE
         WHEN ai.metadata->>'is_enterprise_install' = 'true' THEN 'true'
         ELSE 'false'
       END
  );

-- 2. Retire stale org-wide (`E…`-keyed) connections superseded by a live
--    per-workspace (`T…`) connection of the same enterprise in the same org.
--    `external_tenant_id` starting with 'E' identifies the org-wide generation;
--    the live sibling carries this enterprise id in its backfilled metadata.
--    An active backing install means the org-wide connection is intentional,
--    not orphaned, so it must remain available for sibling-workspace routing.
UPDATE connections dead
SET deleted_at = now(), status = 'paused', updated_at = now()
FROM connections live
WHERE dead.connector_key = 'slack'
  AND dead.credential_mode = 'managed'
  AND dead.status = 'active'
  AND dead.deleted_at IS NULL
  AND dead.external_tenant_id LIKE 'E%'
  AND live.organization_id = dead.organization_id
  AND live.connector_key = 'slack'
  AND live.credential_mode = 'managed'
  AND live.status = 'active'
  AND live.deleted_at IS NULL
  AND live.id <> dead.id
  AND live.config->'chatMetadata'->>'enterpriseId' = dead.external_tenant_id
  AND NOT EXISTS (
    SELECT 1
    FROM app_installations dead_ai
    WHERE dead_ai.organization_id = dead.organization_id
      AND dead_ai.provider = 'slack'
      AND dead_ai.metadata->>'external_id' = dead.slug
      AND dead_ai.status = 'active'
  );

-- migrate:down

-- Data cleanup is not reversed: restoring superseded connections would recreate
-- ambiguous routing, and prior metadata values cannot be reconstructed.
SELECT 1;
