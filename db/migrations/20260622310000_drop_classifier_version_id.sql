-- migrate:up

-- Classifier collapse (P4 phase 5d, CONTRACT): drop event_classifications.classifier_version_id.
-- The output now carries the STABLE classifier_id (phase 1 column + phase-1 BEFORE trigger that
-- derived it from the version). Phases 5b/5c flipped EVERY read + the DELETE/missing-check, and the
-- 5d writer-flip (this PR) makes all three INSERT writers + the version-upgrade DELETEs write
-- classifier_id directly. The per-version id is now dead weight that churns the uniqueness key on
-- every config bump — retire it.
--
-- 🚨 DO NOT APPLY until the writer-flip is UNIVERSAL in prod (every replica writes classifier_id
-- and stops writing classifier_version_id) AND scripts/backfill-classifier-stable-id.sh +
-- scripts/dedup-classifications-for-classifier-id.sh have run to completion (classifier_id NOT NULL
-- on every row, collisions collapsed) so idx_cc_unique_per_source_v2 (5a) is the sole enforcer.
-- expand->contract release N+1, same shape as the P1 #1466 / P6 #1477 drops.
--
-- OPERATIONAL COST: metadata-only at deploy on a modern Postgres. The phase-1 trigger derived
-- classifier_id from classifier_version_id on every write; dropping the version column means the
-- trigger + its function are now inert and go too. SET NOT NULL on classifier_id requires a full
-- scan to verify (no rewrite); the out-of-band backfill is the precondition that makes it pass
-- without a long lock. No data movement: classifier_id is already populated.

-- Drop the phase-1 derive-trigger + function: with classifier_version_id gone there is nothing to
-- derive classifier_id FROM. Writers now supply classifier_id directly.
DROP TRIGGER IF EXISTS trg_set_event_classification_classifier_id ON public.event_classifications;
DROP FUNCTION IF EXISTS public.set_event_classification_classifier_id();

-- Drop the OLD version-keyed uniqueness index; the stable-key idx_cc_unique_per_source_v2 (5a)
-- survives as the sole per-source uniqueness enforcer. The plain lookup index on the version column
-- is auto-dropped with the column below.
-- squawk-ignore require-concurrent-index-deletion -- ACCESS EXCLUSIVE lock acceptable in deploy hook; brief, and the v2 index already covers reads
DROP INDEX IF EXISTS public.idx_cc_unique_per_source;

-- Drop BOTH FKs on classifier_version_id -> event_classifier_versions. The second
-- (event_classifications_classifier_id_fkey) is a misnamed historical duplicate that also points at
-- classifier_version_id; we reuse that name for the real classifier_id FK below.
ALTER TABLE public.event_classifications
  DROP CONSTRAINT IF EXISTS event_classifications_classifier_version_id_fkey,
  DROP CONSTRAINT IF EXISTS event_classifications_classifier_id_fkey;

-- squawk-ignore ban-drop-column -- the whole point of this contract migration; idx_cc_classifier_version_id is auto-dropped with it
ALTER TABLE public.event_classifications DROP COLUMN IF EXISTS classifier_version_id;

-- classifier_id is the durable key now — required on every row. The out-of-band backfill
-- (precondition) guarantees no NULLs remain, so this verification scan passes quickly.
-- squawk-ignore prefer-robust-stmts,adding-not-nullable-field -- backfill precondition removes NULLs; scan-lock acceptable in deploy hook
ALTER TABLE public.event_classifications ALTER COLUMN classifier_id SET NOT NULL;

-- Re-point the classifier FK at the STABLE classifier. ON DELETE CASCADE: a classification is output
-- PRODUCED BY a classifier — once the classifier is gone the label is a meaningless orphan, so it
-- cascades with it.
--
-- ⚠️ DELIBERATE BEHAVIOR CHANGE (acknowledged — flagged in adversarial review): the OLD FK was
-- classifier_VERSION_id -> event_classifier_versions ON DELETE RESTRICT. That RESTRICT, sitting under
-- the event_classifier_versions -> event_classifiers CASCADE, BLOCKED any hard delete that reached a
-- classifier-with-classifications via the transitive cascades INTO event_classifiers:
--   organization (CASCADE) -> event_classifiers
--   watchers     (CASCADE) -> event_classifiers
--   entities     (fk_event_classifiers_entity CASCADE) -> event_classifiers   [force_delete_tree]
-- i.e. force-deleting an org / watcher / entity-tree that owned such a classifier used to ERROR and
-- roll back. With the stable-key CASCADE it now SUCCEEDS and tears the classifications down too. This
-- is the correct force-delete semantics (force means force; orphaned labels shouldn't block a
-- teardown), but it IS a widening from "blocked" to "destroys", so it is called out explicitly. The
-- COMMON path is unaffected: app-level classifier delete is a soft status='deprecated' UPDATE, and
-- ordinary entity delete is gated by the events-count guard; only explicit force_delete_tree /
-- org-deletion / hard test-cleanup reach the cascade.
--
-- NOT VALID + VALIDATE so the existing-row check doesn't take an ACCESS EXCLUSIVE lock for the scan.
-- squawk-ignore prefer-bigint-over-int -- bigint FK column; not an int add
ALTER TABLE public.event_classifications
  ADD CONSTRAINT event_classifications_classifier_id_fkey
  FOREIGN KEY (classifier_id) REFERENCES public.event_classifiers (id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE public.event_classifications
  VALIDATE CONSTRAINT event_classifications_classifier_id_fkey;

-- migrate:down

-- Re-add the per-version column (nullable first), recreate the phase-1 derive trigger + function,
-- backfill classifier_version_id from each classifier's CURRENT version, then re-add the FKs, the
-- old unique/lookup indexes, and finally SET NOT NULL. NOTE: this is a best-effort restore — it maps
-- every classification to its classifier's CURRENT version (historical per-version associations are
-- not recoverable once dropped), which is sufficient to satisfy the FKs + the old uniqueness key.

ALTER TABLE public.event_classifications
  DROP CONSTRAINT IF EXISTS event_classifications_classifier_id_fkey;

-- squawk-ignore prefer-bigint-over-int -- bigint column re-add
ALTER TABLE public.event_classifications ADD COLUMN IF NOT EXISTS classifier_version_id bigint;

CREATE OR REPLACE FUNCTION public.set_event_classification_classifier_id() RETURNS trigger AS $$
BEGIN
  IF NEW.classifier_version_id IS NULL THEN
    NEW.classifier_id := NULL;
    RETURN NEW;
  END IF;
  SELECT ecv.classifier_id INTO NEW.classifier_id
  FROM public.event_classifier_versions ecv
  WHERE ecv.id = NEW.classifier_version_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_event_classification_classifier_id
  BEFORE INSERT OR UPDATE OF classifier_version_id ON public.event_classifications
  FOR EACH ROW EXECUTE FUNCTION public.set_event_classification_classifier_id();

-- Backfill the version id from the classifier's current version (best-effort historical restore).
UPDATE public.event_classifications ec
SET classifier_version_id = ecv.id
FROM public.event_classifier_versions ecv
WHERE ecv.classifier_id = ec.classifier_id
  AND ecv.is_current = true
  AND ec.classifier_version_id IS NULL;

-- Re-add the original FKs (the misnamed duplicate + the version FK). NOT VALID + VALIDATE to keep
-- squawk happy on the down path; the backfill above already satisfies both.
ALTER TABLE public.event_classifications
  ADD CONSTRAINT event_classifications_classifier_id_fkey
  FOREIGN KEY (classifier_version_id) REFERENCES public.event_classifier_versions (id) NOT VALID;
ALTER TABLE public.event_classifications
  VALIDATE CONSTRAINT event_classifications_classifier_id_fkey;
ALTER TABLE public.event_classifications
  ADD CONSTRAINT event_classifications_classifier_version_id_fkey
  FOREIGN KEY (classifier_version_id) REFERENCES public.event_classifier_versions (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.event_classifications
  VALIDATE CONSTRAINT event_classifications_classifier_version_id_fkey;

-- Re-add the old version-keyed indexes.
-- squawk-ignore require-concurrent-index-creation -- down/rollback path only, not a forward deploy
CREATE INDEX IF NOT EXISTS idx_cc_classifier_version_id
  ON public.event_classifications (classifier_version_id);
-- squawk-ignore require-concurrent-index-creation -- down/rollback path only, not a forward deploy
CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unique_per_source
  ON public.event_classifications (event_id, classifier_version_id, source, COALESCE(watcher_id, (0)::bigint));

-- squawk-ignore prefer-robust-stmts,adding-not-nullable-field -- down/rollback path only; backfill above removes NULLs
ALTER TABLE public.event_classifications ALTER COLUMN classifier_version_id SET NOT NULL;
