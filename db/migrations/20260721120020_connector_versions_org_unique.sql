-- migrate:up transaction:false

-- Arbiter for org-scoped artifact rows: one row per (org, key, version).
-- Built before the shared arbiter and before the old global unique is retired
-- (20260721120040) so writes are never left without uniqueness.
--
-- The INVALID-carcass heal is inlined here (not a standalone companion
-- migration) so it re-runs on every retry. A separate heal migration records
-- as applied on its first success; if THIS CONCURRENTLY build then crashes it
-- leaves an INVALID same-named carcass, and the retry — which skips the
-- already-applied heal — never clears it, so CREATE ... IF NOT EXISTS silently
-- no-ops over the carcass and records this migration as applied with a
-- non-enforcing INVALID index (a silent cross-org uniqueness hole). Inlined,
-- the heal drops the carcass on every attempt so the build always converges.
-- The runners split transaction:false sections statement-at-a-time (prod:
-- scripts/migrate-up.mjs; embedded/tests: db/migration-loader.ts), so the heal
-- DO and the CONCURRENTLY build each run unwrapped — CONCURRENTLY is never
-- trapped in an implicit multi-statement transaction.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'connector_versions_org_key_version'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.connector_versions_org_key_version';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS connector_versions_org_key_version
  ON public.connector_versions (organization_id, connector_key, version)
  WHERE organization_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.connector_versions_org_key_version;
