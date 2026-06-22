-- migrate:up

-- Watcher-render fold phase 4b (final): drop the now-dead watcher_versions.json_template
-- column. The render moved to view_template_versions (reads flipped in phase 2, writes in
-- 3a, mirror trigger retired + INSERTs stopped writing it in 3b). Removed from
-- QUERYABLE_SCHEMA in phase 4a, so buildScopedQuery no longer emits it in query_sql CTEs.
-- Safe after 4a is universal: no pod reads, writes, or queries the column.

ALTER TABLE public.watcher_versions DROP COLUMN IF EXISTS json_template;

-- migrate:down

-- Re-add the column (nullable). Backfill from view_template_versions for current renders
-- so a rollback to pre-4b code that reads watcher_versions.json_template sees data.
ALTER TABLE public.watcher_versions ADD COLUMN IF NOT EXISTS json_template jsonb;
UPDATE public.watcher_versions wv
SET json_template = vtv.json_template
FROM public.view_template_versions vtv
WHERE vtv.resource_type = 'watcher' AND vtv.resource_id = wv.watcher_id::text
  AND vtv.version = wv.version AND vtv.tab_name IS NULL;
