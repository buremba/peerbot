-- Recover the fallback `agent_id` that an enterprise→workspace supersede dropped.
--
-- The projection's enterprise-sibling supersede (#2166) retires a stale org-wide
-- (`E…`-keyed) connection when a per-workspace (`T…`) reinstall arrives. The
-- successor is a NEW slug, so it takes the INSERT path and starts `agent_id`
-- NULL — `preserveAgentId` only protects a SAME-slug conflict UPDATE. The
-- admin-configured fallback routing on the retired generation was therefore lost.
--
-- With no owning agent, `resolveAgentId` has no connection-owner to fall back to:
-- inbound messages hit the unclaimed-workspace responder ("this channel isn't
-- linked to one of your agents yet") and any channel that relied on that fallback
-- goes dark in history. Prod hit this on org_lobucrm — connection 448
-- (LobuSandbox `T0BCYB6JV3L`) came up ownerless after 430 (`E0BDSKL1KJL`,
-- `agent_id = crm`) was tombstoned three minutes earlier.
--
-- The code fix makes the supersede carry `agent_id` onto its successor. This
-- migration repairs rows the old code already orphaned: adopt the tombstoned
-- enterprise generation's `agent_id` onto its live workspace successor, but only
-- where the successor has NO binding of its own (COALESCE semantics — an explicit
-- binding always wins, so stale routing can never displace live routing).

-- migrate:up

UPDATE connections live
SET agent_id = dead.agent_id, updated_at = now()
FROM connections dead
WHERE live.connector_key = 'slack'
  AND live.credential_mode = 'managed'
  AND live.status = 'active'
  AND live.deleted_at IS NULL
  AND live.agent_id IS NULL
  AND dead.organization_id = live.organization_id
  AND dead.connector_key = 'slack'
  AND dead.credential_mode = 'managed'
  AND dead.deleted_at IS NOT NULL
  AND dead.agent_id IS NOT NULL
  AND dead.id <> live.id
  -- The retired row is THIS workspace's enterprise generation: the live row's
  -- backfilled metadata names the enterprise the dead row was keyed on.
  AND dead.external_tenant_id = live.config->'chatMetadata'->>'enterpriseId'
  -- The agent must still exist in the org, or the adopted binding dangles.
  AND EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = dead.agent_id
      AND a.organization_id = live.organization_id
  )
  -- Exactly one candidate donor: ambiguous provenance is left for a human.
  AND (
    SELECT count(*)
    FROM connections other
    WHERE other.organization_id = live.organization_id
      AND other.connector_key = 'slack'
      AND other.credential_mode = 'managed'
      AND other.deleted_at IS NOT NULL
      AND other.agent_id IS NOT NULL
      AND other.external_tenant_id = live.config->'chatMetadata'->>'enterpriseId'
  ) = 1;

-- migrate:down

-- Not reversed: clearing an adopted `agent_id` cannot distinguish the value this
-- migration restored from one an admin has since set deliberately.
SELECT 1;
