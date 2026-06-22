-- migrate:up

-- Classifier consolidation (P4) phase 1 (expand): add a STABLE classifier_id to
-- event_classifications. Today the output only carries classifier_version_id (per-version,
-- churns on every config bump); the stable classifier identity is reachable only by joining
-- event_classifier_versions. A denormalized classifier_id lets future reads resolve the
-- stable classifier directly, and is the foundation for repointing the output to a stable
-- classifier home so labels survive config version churn / the version table being retired.
--
-- Additive + low-risk: nothing READS classifier_id yet. A BEFORE-trigger keeps it populated
-- from every replica's writes (the hot-path classification runtime does DELETE+INSERT here);
-- the lookup is a single PK hit on event_classifier_versions.
--
-- OPERATIONAL COST (per docs/MIGRATIONS.md): this migration is O(1) at deploy — a nullable
-- column add (metadata-only) + trigger create. NO inline backfill: event_classifications is
-- events-scaled (prod ~1M+ rows), so a full-table UPDATE in the Helm hook would risk the
-- statement_timeout / non-zero-exit outage pattern (PR #767). Historic rows stay NULL until
-- the out-of-band batched backfill (scripts/backfill-classifier-stable-id.sh, ~10k/batch);
-- nothing reads classifier_id until the staging-gated read phase, so there's no urgency.

-- squawk-ignore prefer-bigint-over-int -- bigint stores the integer classifier id; matches classifier_version_id width
ALTER TABLE public.event_classifications ADD COLUMN IF NOT EXISTS classifier_id bigint;

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

-- Historic rows are backfilled OUT OF BAND (batched) — see the header note + the runbook
-- scripts/backfill-classifier-stable-id.sh. NOT done inline (events-scaled hot table).

-- migrate:down

DROP TRIGGER IF EXISTS trg_set_event_classification_classifier_id ON public.event_classifications;
DROP FUNCTION IF EXISTS public.set_event_classification_classifier_id();
ALTER TABLE public.event_classifications DROP COLUMN IF EXISTS classifier_id;
