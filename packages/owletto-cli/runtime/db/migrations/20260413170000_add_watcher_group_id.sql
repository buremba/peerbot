-- migrate:up

ALTER TABLE public.watchers
  ADD COLUMN IF NOT EXISTS source_watcher_id integer,
  ADD COLUMN IF NOT EXISTS watcher_group_id integer;

-- Backfill source watcher links from cloned watcher versions.
WITH derived_source AS (
  SELECT DISTINCT ON (w.id)
    w.id AS watcher_id,
    source_versions.watcher_id AS source_watcher_id
  FROM public.watchers w
  JOIN public.watcher_versions wv ON wv.watcher_id = w.id
  JOIN public.watcher_versions source_versions
    ON source_versions.id = substring(wv.change_notes FROM 'Created from version ([0-9]+)')::integer
  WHERE wv.change_notes ~ 'Created from version [0-9]+'
  ORDER BY w.id, wv.version ASC, wv.id ASC
)
UPDATE public.watchers w
SET source_watcher_id = ds.source_watcher_id
FROM derived_source ds
WHERE w.id = ds.watcher_id
  AND w.source_watcher_id IS NULL;

-- Build stable watcher group ids by walking source watcher ancestry to the root.
WITH RECURSIVE roots AS (
  SELECT w.id AS watcher_id, w.source_watcher_id, w.id AS root_id
  FROM public.watchers w
  WHERE w.source_watcher_id IS NULL

  UNION ALL

  SELECT child.id AS watcher_id, child.source_watcher_id, roots.root_id
  FROM public.watchers child
  JOIN roots ON child.source_watcher_id = roots.watcher_id
)
UPDATE public.watchers w
SET watcher_group_id = roots.root_id
FROM roots
WHERE w.id = roots.watcher_id;

-- Fallback for any rows that did not match the recursive backfill.
UPDATE public.watchers
SET watcher_group_id = id
WHERE watcher_group_id IS NULL;

-- `watchers.current_version_id` has a DEFERRABLE FK. The backfill updates above queue
-- deferred trigger events, and PostgreSQL refuses ALTER TABLE while those are pending.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE public.watchers
  ALTER COLUMN watcher_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_watchers_watcher_group_id
  ON public.watchers USING btree (watcher_group_id);

CREATE INDEX IF NOT EXISTS idx_watchers_org_group
  ON public.watchers USING btree (organization_id, watcher_group_id);

-- migrate:down

DROP INDEX IF EXISTS idx_watchers_org_group;
DROP INDEX IF EXISTS idx_watchers_watcher_group_id;

ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS watcher_group_id,
  DROP COLUMN IF EXISTS source_watcher_id;
