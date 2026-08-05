-- migrate:up

-- One-time data cleanup for the buremba org: hard-delete residual rows under
-- entity types that are no longer part of the org's live schema.
--
-- Two distinct shapes are purged:
--   * company / city / product — rows imported under the PUBLIC catalog types
--     owned by the market/sales orgs. The TYPES themselves are not ours to
--     delete (works_at / uses_technology reference them); only the org's own
--     soft-deleted rows under them are removed.
--   * social-signal / mcp-e2e-* / mcp-graph-* / mcp-readiness-* / lobu-e2e-temp
--     — rows under org-local types that were already soft-deleted (their type
--     rows have deleted_at set, so deleteType no longer resolves them). These
--     are MCP/e2e test artifacts and the pre-event social-signal era.
--
-- Every row purged already has deleted_at IS NOT NULL (invisible to all reads;
-- the residual value is disk + scan cost only). Live rows are never touched.
--
-- Dangling references, verified before writing this migration:
--   * 80 live entity_relationships (all buremba-owned, confirmed by query)
--     reference these rows → deleted first.
--   * 48 events carry these ids in events.entity_ids. events is append-only
--     and the app already treats missing entity ids as "detached" (the
--     force_delete_tree path relies on it), so those arrays are left as-is.
--
-- Scope: organization_id pins this to the buremba org on the shared prod DB;
-- other orgs' rows (including the market/sales orgs that own the public types)
-- are untouched. The relationship delete is org-scoped too — all 80 live
-- references are buremba-owned, so the scope loses nothing and never touches
-- another org's relationship rows.
-- squawk-ignore prefer-robust-stmts -- single-org data cleanup; row sets are re-derived from the same predicates on both statements so the counts cannot drift

WITH zombie AS (
  SELECT id
  FROM public.entities
  WHERE organization_id = '8dc12bdd-5d8c-4768-a2e9-a18005cc5ebd'
    AND entity_type IN (
      'company', 'social-signal', 'city', 'product',
      'mcp-e2e-mrtowdgd', 'mcp-graph-mrt80dq0', 'mcp-graph-mrt7zszi',
      'mcp-readiness-mrt7sast', 'lobu-e2e-temp'
    )
    AND deleted_at IS NOT NULL
)
DELETE FROM public.entity_relationships
WHERE organization_id = '8dc12bdd-5d8c-4768-a2e9-a18005cc5ebd'
  AND deleted_at IS NULL
  AND (from_entity_id IN (SELECT id FROM zombie) OR to_entity_id IN (SELECT id FROM zombie));

DELETE FROM public.entities
WHERE organization_id = '8dc12bdd-5d8c-4768-a2e9-a18005cc5ebd'
  AND entity_type IN (
    'company', 'social-signal', 'city', 'product',
    'mcp-e2e-mrtowdgd', 'mcp-graph-mrt80dq0', 'mcp-graph-mrt7zszi',
    'mcp-readiness-mrt7sast', 'lobu-e2e-temp'
  )
  AND deleted_at IS NOT NULL;

-- migrate:down

-- Irreversible: the purged rows were soft-deleted tombstones whose content
-- cannot be reconstructed from the remaining rows. No rollback.
