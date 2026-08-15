-- migrate:up

-- Remove ACL-enforcement rows whose connection no longer exists as a LIVE
-- `connections` row. `authz_source_acl_state` is a pure materialization of a
-- source's access graph — rebuilt from scratch by the next ACL sync, referenced
-- by nothing — and no code path ever deleted from it, so every connection
-- deleted before this change left its row orphaned forever as e.g. 'full' or
-- 'failed', inflating any "failed connections" count. Deleting orphans is safe
-- for the same reason: the row is derivable and nothing depends on it.
--
-- `authz_source_acl_state.connection_id` is the connection's RUNTIME id, which
-- differs per connector type:
--   * a managed Slack install is keyed by its `slackinst-…` slug verbatim;
--   * a BYO Slack connection by its `agentconn-`-stripped runtime id;
--   * a data connector (GitHub) by its numeric `connections.id::text`.
-- The predicate below matches every shape and must stay in lockstep with
-- `ACL_ROW_CONNECTION_ALIVE_SQL` in
-- packages/server/src/authz/acl-observability.ts (the connector-health scan
-- matches the same shapes; delete-time cleanup calls `deleteConnectionAclRows`).
DELETE FROM public.authz_source_acl_state a
WHERE NOT EXISTS (
  SELECT 1
  FROM public.connections c
  WHERE c.organization_id = a.organization_id
    AND c.deleted_at IS NULL
    AND (
      a.connection_id = c.slug
      OR a.connection_id = c.id::text
      OR a.connection_id = CASE
            WHEN c.slug LIKE 'agentconn-%' THEN substr(c.slug, length('agentconn-') + 1)
            ELSE c.slug
          END
    )
);

-- migrate:down

-- No-op: the swept rows were orphans whose connection no longer exists, and
-- the ACL state is a materialization the next sync rebuilds anyway — there is
-- nothing to restore.
