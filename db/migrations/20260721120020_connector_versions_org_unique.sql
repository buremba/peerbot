-- migrate:up transaction:false

-- Arbiter for org-scoped artifact rows: one row per (org, key, version).
-- Built before the shared arbiter and before the old global unique is retired
-- (20260721120040) so writes are never left without uniqueness. Single
-- statement so dbmate does not wrap CONCURRENTLY in an implicit transaction.
-- INVALID-carcass heal runs first in 20260721120010.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS connector_versions_org_key_version
  ON public.connector_versions (organization_id, connector_key, version)
  WHERE organization_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.connector_versions_org_key_version;
