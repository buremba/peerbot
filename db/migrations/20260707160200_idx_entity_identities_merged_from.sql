-- migrate:up transaction:false

-- Reverse-lookup index for un-merge: find every identity moved FROM a given
-- loser (`WHERE merged_from_entity_id = <loser>`). Partial — only merge-moved
-- rows carry the marker, so the index stays small.
--
-- CONCURRENTLY (transaction:false, one statement): `entity_identities` is a hot
-- table; a plain build would block writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_merged_from
  ON public.entity_identities USING btree (merged_from_entity_id)
  WHERE merged_from_entity_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_merged_from;
