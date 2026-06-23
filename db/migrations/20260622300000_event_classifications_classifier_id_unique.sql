-- migrate:up transaction:false

-- Classifier collapse (P4 phase 5a, expand): the stable-key uniqueness index that will replace
-- idx_cc_unique_per_source (event_id, classifier_version_id, source, COALESCE(watcher_id,0)) when
-- the version column is dropped in the contract phase. Keyed on the stable classifier_id (phase 1)
-- instead of the per-version id.
--
-- CONCURRENTLY (transaction:false) because event_classifications is events-scaled (~1M+ rows) — an
-- exclusive-lock index build would block the classification hot path (docs/MIGRATIONS.md).
-- PRECONDITION (run to completion BEFORE this migration applies in prod):
--   1. scripts/backfill-classifier-stable-id.sh  (classifier_id populated on all rows)
--   2. scripts/dedup-classifications-for-classifier-id.sh  (collapse-key collisions removed)
-- else CREATE UNIQUE INDEX CONCURRENTLY aborts on a duplicate. Additive — the OLD index stays
-- alongside until the contract phase (5d), so both keys are enforced through the writer flip.

-- squawk-ignore prefer-bigint-over-int -- not an int column; index only
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cc_unique_per_source_v2
  ON public.event_classifications (event_id, classifier_id, source, COALESCE(watcher_id, (0)::bigint));

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_cc_unique_per_source_v2;
