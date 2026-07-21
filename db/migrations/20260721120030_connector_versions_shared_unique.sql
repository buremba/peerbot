-- migrate:up transaction:false

-- Arbiter for shared/bundled artifact rows (organization_id IS NULL): the
-- partial replacement for the old global idx_connector_versions_key_version,
-- which must retire (20260721120040) because an org-scoped row legitimately
-- shares (connector_key, version) with the shared bundled row it shadows.
-- Single statement so dbmate does not wrap CONCURRENTLY in an implicit
-- transaction. INVALID-carcass heal runs first in 20260721120010.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS connector_versions_shared_key_version
  ON public.connector_versions (connector_key, version)
  WHERE organization_id IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.connector_versions_shared_key_version;
