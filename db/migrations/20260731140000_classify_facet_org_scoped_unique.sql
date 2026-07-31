-- migrate:up

-- `classify_facet_unique_per_insight` was UNIQUE (entity_id, watcher_id, slug)
-- with NO organization_id, so a classifier slug is currently unique across the
-- WHOLE INSTALL rather than within a tenant. The three-column key was inherited
-- verbatim from `event_classifiers` in 20260622320000 to match the extraction
-- upsert's ON CONFLICT target; that table had the same omission and nobody
-- re-derived the key when classify_facet became multi-tenant.
--
-- The practical effect is org-level classifiers (entity_id NULL, watcher_id
-- NULL), which is exactly what `manage_classifiers create` produces and the only
-- kind `apply` can match. Two tenants cannot both hold `sentiment`: the second
-- one's create dies on a unique violation naming another tenant's row. Measured
-- on prod 2026-07-31 — 29 classifiers, and only 3 sit in that globally-unique
-- bucket (`impact`, `test-classifier`, `post-sentiment`) across 2 orgs. They
-- collide on nothing today purely because the slugs happen to differ, so this is
-- latent rather than firing: the next org to pick a taken slug hits it.
--
-- organization_id is NOT NULL on this table (verified against prod), so adding
-- it to the key introduces no NULL-matching subtlety. NULLS NOT DISTINCT is
-- retained for entity_id/watcher_id, which ARE nullable and whose NULLs must
-- keep colliding — that is what makes "one org-level classifier per slug per
-- org" an enforced constraint rather than an unchecked convention.
--
-- Strictly a widening: every key unique under the old constraint stays unique
-- under the new one, so no existing row can conflict and no backfill is needed.

ALTER TABLE classify_facet DROP CONSTRAINT IF EXISTS classify_facet_unique_per_insight;
-- squawk-ignore disallowed-unique-constraint,prefer-robust-stmts,constraint-missing-not-valid -- config-scale table (29 rows on prod); brief lock acceptable; dbmate wraps in a transaction
ALTER TABLE classify_facet ADD CONSTRAINT classify_facet_unique_per_insight
    UNIQUE NULLS NOT DISTINCT (organization_id, entity_id, watcher_id, slug);

COMMENT ON CONSTRAINT classify_facet_unique_per_insight ON classify_facet IS
    'One classifier per (org, entity, behavior, slug). organization_id leads because slugs are tenant-scoped names, not global ones; the extraction upsert in classifier-extraction.ts must target these four columns exactly.';

-- migrate:down

-- Narrowing, so this aborts if two tenants have since taken the same slug —
-- correctly. Resolve the duplicates first; PITR is the alternative.
ALTER TABLE classify_facet DROP CONSTRAINT IF EXISTS classify_facet_unique_per_insight;
-- squawk-ignore disallowed-unique-constraint,prefer-robust-stmts,constraint-missing-not-valid -- rollback path; same config-scale table, brief lock acceptable
ALTER TABLE classify_facet ADD CONSTRAINT classify_facet_unique_per_insight
    UNIQUE NULLS NOT DISTINCT (entity_id, watcher_id, slug);
