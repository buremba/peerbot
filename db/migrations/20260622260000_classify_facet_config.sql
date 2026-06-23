-- migrate:up

-- Classifier consolidation (P4) phase 3 (expand): fold the CURRENT version's config from
-- event_classifier_versions into classify_facet, so the facet is a complete config-home (the
-- later hot-path classification-runtime flip reads the full config from one place). A trigger
-- mirrors the config whenever a version becomes is_current; the inline backfill seeds it from
-- each classifier's current version. Additive — nothing reads these columns yet; the hot-path
-- read flip + the drop of event_classifiers/_versions are STAGING-GATED later phases.
--
-- OPERATIONAL COST: O(rows) but event_classifier_versions is CONFIG-SCALE (a handful of
-- versions per classifier, not events-scaled), so the inline backfill is safe per
-- docs/MIGRATIONS.md (unlike the events-scaled backfills which are out-of-band).

ALTER TABLE public.classify_facet
  ADD COLUMN IF NOT EXISTS current_version_id bigint,
  ADD COLUMN IF NOT EXISTS attribute_values jsonb,
  ADD COLUMN IF NOT EXISTS min_similarity numeric,
  ADD COLUMN IF NOT EXISTS fallback_value text,
  ADD COLUMN IF NOT EXISTS preferred_model text,
  ADD COLUMN IF NOT EXISTS extraction_config jsonb;

CREATE OR REPLACE FUNCTION public.sync_classify_facet_config() RETURNS trigger AS $$
BEGIN
  -- Only the CURRENT version drives the facet's config (one current version per classifier).
  IF NEW.is_current IS NOT TRUE THEN RETURN NEW; END IF;
  UPDATE public.classify_facet SET
    current_version_id = NEW.id,
    attribute_values = NEW.attribute_values,
    min_similarity = NEW.min_similarity,
    fallback_value = NEW.fallback_value,
    preferred_model = NEW.preferred_model,
    extraction_config = NEW.extraction_config
  WHERE id = NEW.classifier_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fire on is_current AND the config columns: versions are NOT immutable — the CURRENT
-- version's attribute_values are edited IN PLACE (manage_classifiers.ts:718 manual classify,
-- classifier-extraction.ts:390 value learning) without touching is_current, so an
-- is_current-only trigger would leave the facet config stale. The function still only mirrors
-- when the (edited) row is the current version.
CREATE TRIGGER trg_sync_classify_facet_config
  AFTER INSERT OR UPDATE OF
    is_current, attribute_values, min_similarity, fallback_value, preferred_model, extraction_config
  ON public.event_classifier_versions
  FOR EACH ROW EXECUTE FUNCTION public.sync_classify_facet_config();

-- Inline backfill (config-scale): each facet gets its current version's config.
UPDATE public.classify_facet cf SET
  current_version_id = ecv.id,
  attribute_values = ecv.attribute_values,
  min_similarity = ecv.min_similarity,
  fallback_value = ecv.fallback_value,
  preferred_model = ecv.preferred_model,
  extraction_config = ecv.extraction_config
FROM public.event_classifier_versions ecv
WHERE ecv.classifier_id = cf.id AND ecv.is_current = true;

-- migrate:down

DROP TRIGGER IF EXISTS trg_sync_classify_facet_config ON public.event_classifier_versions;
DROP FUNCTION IF EXISTS public.sync_classify_facet_config();
ALTER TABLE public.classify_facet
  DROP COLUMN IF EXISTS current_version_id,
  DROP COLUMN IF EXISTS attribute_values,
  DROP COLUMN IF EXISTS min_similarity,
  DROP COLUMN IF EXISTS fallback_value,
  DROP COLUMN IF EXISTS preferred_model,
  DROP COLUMN IF EXISTS extraction_config;
