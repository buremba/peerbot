-- migrate:up

-- An org-scoped ACL invalidation counter.
--
-- The freshness fence in `markAclFresh` compared
-- `authz_source_acl_state.updated_at < syncStartedAt`, which orders STATEMENT
-- timestamps, not commit visibility. An unmerge could stamp `updated_at` at T1
-- and commit at T3; a sync starting at T2 (T1 < T2 < T3) never saw the unmerge
-- in its snapshot, yet the fence read T1 < T2 and blessed the connection
-- `fresh` on membership that predates the revocation.
--
-- A counter closes it: the sync reads the generation before it reads or
-- reconciles membership, and the stamp refuses unless it is still unchanged.
-- An invalidation that commits mid-sync bumps it and the stamp is skipped.
--
-- It lives on `organization` rather than `authz_source_acl_state` because an
-- entity-graph invalidation can affect every connection and must also fence the
-- INSERT path: a sync that began before the invalidation can create a brand-new
-- state row afterward, and a per-row counter cannot guard a row that did not
-- exist to be bumped.
ALTER TABLE public.organization
  ADD COLUMN IF NOT EXISTS acl_generation bigint NOT NULL DEFAULT 0;

-- migrate:down

ALTER TABLE public.organization
  DROP COLUMN IF EXISTS acl_generation;
