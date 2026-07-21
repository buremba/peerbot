-- migrate:up

-- Step 3 of the connector_versions isolation rollout (#2045 follow-up).
--
-- Attribute retained custom artifacts to their owning organizations: every
-- shared row carrying org-supplied content (source_code / compiled_code —
-- bundled catalog rows carry only a source_path pointer and stay shared) is
-- copied to each organization holding a connector_definitions row for that
-- key, so every installer keeps its full retained history on its own rows.
-- No status filter: a disabled connector's history must survive for
-- rollback_connector_version after re-enable.
--
-- Only ORG-OWNED definitions are backfill targets (d.organization_id IS NOT
-- NULL). A connector_definitions row with organization_id IS NULL is a
-- bundled catalog definition, not an org install — copying a shared custom
-- row to it re-emits a shared (organization_id IS NULL) row that collides
-- with the source row on the connector_versions_shared_key_version arbiter,
-- which this INSERT's org-only ON CONFLICT clause does not cover, aborting
-- the migration. Bundled definitions own nothing; their shared rows stay put.
INSERT INTO public.connector_versions (
  connector_key, version, organization_id, compiled_code, compiled_code_hash,
  compile_config_hash, source_code, source_path, created_at
)
SELECT DISTINCT ON (d.organization_id, cv.connector_key, cv.version)
  cv.connector_key, cv.version, d.organization_id, cv.compiled_code,
  cv.compiled_code_hash, cv.compile_config_hash, cv.source_code,
  cv.source_path, cv.created_at
FROM public.connector_versions cv
JOIN public.connector_definitions d ON d.key = cv.connector_key
WHERE cv.organization_id IS NULL
  AND d.organization_id IS NOT NULL
  AND (cv.source_code IS NOT NULL OR cv.compiled_code IS NOT NULL)
ORDER BY d.organization_id, cv.connector_key, cv.version
ON CONFLICT (organization_id, connector_key, version) WHERE organization_id IS NOT NULL
DO NOTHING;

-- Retire the shared copies of custom content: with every definition-holder
-- carrying its own row, a shared custom row is only a cross-org read/activate
-- surface (the #2045 leak tail). Delete only rows some org now retains —
-- orphans (no definition anywhere, so no copy landed) stay shared rather than
-- destroying the sole copy. Old replicas still dual-writing during this
-- deploy's rolling window may recreate a few shared custom rows; they carry
-- code their org row also carries and can be pruned by re-running this
-- statement later.
DELETE FROM public.connector_versions cv
WHERE cv.organization_id IS NULL
  AND (cv.source_code IS NOT NULL OR cv.compiled_code IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM public.connector_versions oc
    WHERE oc.connector_key = cv.connector_key
      AND oc.version = cv.version
      AND oc.organization_id IS NOT NULL
  );

-- migrate:down

-- The copy is additive and the delete removed rows whose bytes live on org
-- rows; recreating the exact pre-migration shared namespace is not possible
-- (nor needed — reads fall back to shared rows only when no org row exists).
SELECT 1;
