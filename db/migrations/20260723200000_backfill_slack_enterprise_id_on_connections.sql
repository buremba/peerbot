-- Backfill the Grid enterprise id onto Slack connection projections, and retire
-- stale org-wide (`E…`-keyed) connections that a later per-workspace reinstall
-- orphaned.
--
-- An ORG-WIDE Grid install returns no `team` from oauth.v2.access, so its
-- connection was keyed on the enterprise `E…` id. A later PER-WORKSPACE reinstall
-- of the same workspace arrives under a `T…` key and mints a NEW connection; the
-- projection's exact-tenant demote could not recognize the `E…` row as the same
-- workspace, so it was left live-but-orphaned (its streaming feed stranded — the
-- damage #2157 cleaned and #2163 stopped recurring on the feed side).
--
-- The code fix (persist `enterpriseId` onto the connection + enterprise-sibling
-- supersede in the projection) prevents new orphans. This migration makes the
-- invariant true for EXISTING rows:
--   1. Backfill `chatMetadata.enterpriseId` / `isEnterpriseInstall` from each
--      connection's backing `app_installations` row, so the projection can match
--      the enterprise on the next reinstall.
--   2. Retire any LIVE org-wide (`E…`-keyed) connection that is already superseded
--      by a live per-workspace (`T…`) connection of the SAME enterprise in the
--      same org. Scoped to Slack managed rows. The retire fires
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
             'isEnterpriseInstall', (ai.metadata->>'is_enterprise_install') = 'true'
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
  AND (c.config->'chatMetadata'->>'enterpriseId') IS DISTINCT FROM (ai.metadata->>'enterprise_id');

-- 2. Retire stale org-wide (`E…`-keyed) connections superseded by a live
--    per-workspace (`T…`) connection of the same enterprise in the same org.
--    `external_tenant_id` starting with 'E' identifies the org-wide generation;
--    the live sibling carries this enterprise id in its backfilled metadata.
UPDATE connections dead
SET deleted_at = now(), status = 'paused', updated_at = now()
FROM connections live
WHERE dead.connector_key = 'slack'
  AND dead.credential_mode = 'managed'
  AND dead.deleted_at IS NULL
  AND dead.external_tenant_id LIKE 'E%'
  AND live.organization_id = dead.organization_id
  AND live.connector_key = 'slack'
  AND live.credential_mode = 'managed'
  AND live.deleted_at IS NULL
  AND live.id <> dead.id
  AND live.config->'chatMetadata'->>'enterpriseId' = dead.external_tenant_id;

-- migrate:down

-- Data cleanup: the retired org-wide rows were orphans with no backing install,
-- and the metadata backfill only mirrors the install's own enterprise id, so
-- neither is reversed.
SELECT 1;
