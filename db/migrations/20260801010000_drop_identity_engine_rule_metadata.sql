-- migrate:up

-- Strip the identity-engine rule blob from relationship types.
--
-- The identity-fact engine (packages/server/src/identity/engine.ts) is deleted.
-- It was the only reader of the compiled rule keys
-- { autoCreateWhen, ruleVersion, ruleHash } that
-- 20260707120000_seed_works_at_email_domain_rule.sql seeded onto
-- `entity_relationship_types.metadata`, and the only writer besides the
-- `manage_entity_schema` admin tool's `auto_create_when` argument, which is
-- removed in the same change.
--
-- Left behind, these keys are inert config describing an engine that no longer
-- exists — and `manage_entity_schema` still returns `rt.metadata` verbatim to
-- agents, so an agent would keep reading rules nothing can act on.
--
-- Scope notes:
--   * This edits ONLY the three rule keys. Any other metadata an org put on a
--     relationship type is preserved by the `-` operator.
--   * The `works_at` relationship TYPE stays — it is real product vocabulary.
--   * Relationship ROWS the engine already derived are left alone. They are
--     knowledge edges (person works_at company), not an access-control edge
--     (`member_of` is the ACL), so deleting them would destroy real inferred
--     data to no safety benefit. They simply stop being maintained.
--   * Not restricted to public-catalog orgs: the admin tool could write these
--     keys on any org's relationship type, so the sweep has to cover all rows.
--     Guarded by a `?|` existence test so untouched rows are not rewritten.

UPDATE entity_relationship_types
SET metadata = metadata - 'autoCreateWhen' - 'ruleVersion' - 'ruleHash',
    updated_at = current_timestamp
WHERE metadata IS NOT NULL
  AND metadata ?| ARRAY['autoCreateWhen', 'ruleVersion', 'ruleHash'];

-- migrate:down

-- Not reversible: the compiled rule blob is not recoverable from what remains.
-- Re-running 20260707120000_seed_works_at_email_domain_rule.sql reseeds the
-- canonical works_at rule if the engine is ever restored.

SELECT 1;
