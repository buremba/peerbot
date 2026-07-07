-- migrate:up transaction:false

-- Partial index backing the merge read-redirect: the recall branch gathers
-- `{winner} ∪ {losers where merged_into = winner}` for the `entity_ids @>` join
-- — a single indexed lookup per query, not per event. Only merged rows are
-- indexed (merged_into is null for live entities), so the index stays tiny.
--
-- CONCURRENTLY (transaction:false, one statement): `entities` is a hot table;
-- a plain CREATE INDEX would block writes for the build. The predicate matches
-- only already-merged rows, so on a fresh column the build is one scan of an
-- empty match set.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_merged_into
  ON public.entities USING btree (merged_into)
  WHERE merged_into IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entities_merged_into;
