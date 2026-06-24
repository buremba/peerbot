-- migrate:up

-- Contract phase of the watcher inline-render removal.
--
-- The columns were made dead in the prior release (lobu#1533, "consolidate
-- render+schema derivation onto entity types"): render and the extraction schema
-- now derive from the target entity type, and no code across server, cli, or the
-- owletto frontend reads or writes watcher_versions.json_template /
-- .extraction_schema anymore. They are NOT in the query_sql table-schema allowlist
-- (packages/server/src/utils/table-schema.ts) — already removed there in #1533 —
-- so no scoped CTE emits them.
--
-- MUST ship in a release AFTER #1533 is fully deployed: until every replica runs
-- the expand-phase code, an old pod's worker-poll query still SELECTs
-- extraction_schema, and dropping it mid-rollout would break that path. Once #1533
-- is live, no running replica references either column, so the drop is safe under
-- a rolling upgrade. DROP COLUMN is an O(1) catalog flip under a brief ACCESS
-- EXCLUSIVE lock — no table rewrite for these jsonb types.

ALTER TABLE public.watcher_versions DROP COLUMN IF EXISTS extraction_schema;
ALTER TABLE public.watcher_versions DROP COLUMN IF EXISTS json_template;

-- migrate:down

ALTER TABLE public.watcher_versions ADD COLUMN IF NOT EXISTS extraction_schema jsonb;
ALTER TABLE public.watcher_versions ADD COLUMN IF NOT EXISTS json_template jsonb;
