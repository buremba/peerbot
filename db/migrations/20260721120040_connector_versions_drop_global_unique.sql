-- migrate:up transaction:false

-- The partial arbiters were built concurrently in the two preceding
-- migrations. Drop the old global unique so an org-scoped row can share
-- (connector_key, version) with the shared bundled row it shadows. Old
-- replicas use the former two-column ON CONFLICT target; during the brief
-- rolling window their connector installs (rare, admin-driven, retryable) can
-- fail without affecting connector execution. New replicas use the
-- predicate-qualified arbiters.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_connector_versions_key_version;

-- migrate:down transaction:false

-- Rollback is possible only before an org row has landed next to a shared row
-- with the same (connector_key, version).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_connector_versions_key_version
  ON public.connector_versions (connector_key, version);
