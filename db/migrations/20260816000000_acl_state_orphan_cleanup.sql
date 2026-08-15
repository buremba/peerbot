-- migrate:up

-- Remove ACL-enforcement rows whose connection no longer exists as a LIVE
-- `connections` row. `authz_source_acl_state` is a pure materialization of a
-- source's access graph — rebuilt from scratch by the next ACL sync, with no
-- foreign-key dependents — and no production deletion path removed from it.
-- Deleting an ACL-enabled connection before this change therefore left its row
-- orphaned as e.g. 'full' or 'failed', inflating any "failed connections"
-- count. Deleting orphans is safe because no live connection can use those rows.
--
-- `authz_source_acl_state.connection_id` is the connection's RUNTIME id, which
-- differs per connector type:
--   * a managed Slack install is keyed by its `slackinst-…` slug verbatim;
--   * a BYO Slack connection by its `agentconn-`-stripped runtime id;
--   * a data connector (GitHub) by its numeric `connections.id::text`.
-- The predicate below mirrors `aclConnectionIdSql` in
-- packages/server/src/authz/acl-observability.ts, which is shared by runtime
-- health and delete paths.
DELETE FROM public.authz_source_acl_state a
WHERE NOT EXISTS (
  SELECT 1
  FROM public.connections c
  WHERE c.organization_id = a.organization_id
    AND c.deleted_at IS NULL
    AND a.connection_id = CASE
          WHEN c.credential_mode IS NULL THEN c.id::text
          WHEN left(c.slug, length('agentconn-')) = 'agentconn-'
            THEN substr(c.slug, length('agentconn-') + 1)
          ELSE c.slug
        END
);

-- migrate:down

-- No-op: the swept state belonged to no live connection and cannot be restored
-- usefully.
