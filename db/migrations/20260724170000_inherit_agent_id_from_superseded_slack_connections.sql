-- Recover fallback routing dropped by an enterprise→workspace supersede.
--
-- The projection's enterprise-sibling supersede (#2166) retires a stale org-wide
-- (`E…`-keyed) connection when a per-workspace (`T…`) reinstall arrives. The
-- successor is a NEW slug, so it takes the INSERT path and starts `agent_id`
-- NULL — `preserveAgentId` only protects a SAME-slug conflict UPDATE. The
-- admin-configured fallback routing on the retired generation was therefore lost.
--
-- Adopt the retired generation's `agent_id` only when both donor and successor
-- provenance are unambiguous. Existing routing always wins.

-- migrate:up

WITH donor_candidates AS (
  SELECT dead.id, dead.organization_id, dead.external_tenant_id, dead.agent_id
  FROM connections dead
  WHERE dead.connector_key = 'slack'
    AND dead.credential_mode = 'managed'
    -- `deleted_at` is the tombstone signal; do NOT also require
    -- `status = 'paused'`. Rows retired before the supersede set `status`
    -- alongside `deleted_at` are still `status = 'active'` while tombstoned
    -- (prod: conn 430 is exactly this), and that filter silently excluded the
    -- only row this migration exists to repair.
    AND dead.deleted_at IS NOT NULL
    AND dead.agent_id IS NOT NULL
    AND dead.external_tenant_id LIKE 'E%'
    AND EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = dead.agent_id
        AND a.organization_id = dead.organization_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app_installations ai
      WHERE ai.organization_id = dead.organization_id
        AND ai.provider = 'slack'
        AND ai.metadata->>'external_id' = dead.slug
        AND ai.status = 'active'
    )
),
donors AS (
  SELECT min(id) AS id, organization_id, external_tenant_id
  FROM donor_candidates
  GROUP BY organization_id, external_tenant_id
  HAVING count(*) = 1
),
successor_candidates AS (
  SELECT
    live.id,
    live.organization_id,
    live.config->'chatMetadata'->>'enterpriseId' AS enterprise_id
  FROM connections live
  WHERE live.connector_key = 'slack'
    AND live.credential_mode = 'managed'
    AND live.status = 'active'
    AND live.deleted_at IS NULL
    AND live.external_tenant_id LIKE 'T%'
    AND EXISTS (
      SELECT 1 FROM app_installations ai
      WHERE ai.organization_id = live.organization_id
        AND ai.provider = 'slack'
        AND ai.metadata->>'external_id' = live.slug
        AND ai.metadata->>'enterprise_id' =
            live.config->'chatMetadata'->>'enterpriseId'
        AND ai.status = 'active'
    )
),
successors AS (
  SELECT min(id) AS id, organization_id, enterprise_id
  FROM successor_candidates
  GROUP BY organization_id, enterprise_id
  HAVING count(*) = 1
)
UPDATE connections live
SET agent_id = donor.agent_id, updated_at = now()
FROM donor_candidates donor
JOIN donors d ON d.id = donor.id
JOIN successors successor
  ON successor.organization_id = donor.organization_id
 AND successor.enterprise_id = donor.external_tenant_id
WHERE live.id = successor.id
  AND live.agent_id IS NULL;

-- migrate:down

-- Not reversed: clearing an adopted `agent_id` cannot distinguish the value this
-- migration restored from one an admin has since set deliberately.
SELECT 1;
