-- migrate:up

-- Classifier consolidation (P4) phase 2 (expand): introduce classify_facet, the stable
-- classifier config-home that will replace event_classifiers (the per-version config in
-- event_classifier_versions folds in a later phase). classify_facet mirrors the stable
-- classifier identity/scope (id = event_classifiers.id), kept in sync by a trigger; the
-- versioned config + the hot-path classification runtime flip are STAGING-GATED later phases
-- (per the P4 audit). Additive — nothing reads classify_facet yet.
--
-- OPERATIONAL COST: O(rows) but event_classifiers is CONFIG-SCALE (one row per classifier;
-- dozens per org, not events-scaled), so the inline backfill is safe in the Helm hook (unlike
-- the events-scaled event_classifications / watcher_window_events backfills, which are
-- out-of-band). Trigger syncs INSERT/UPDATE/DELETE (the windows-as-events lesson: mirror ALL
-- ops, not just INSERT, so it stays accurate).

CREATE TABLE IF NOT EXISTS public.classify_facet (
  id bigint PRIMARY KEY,
  organization_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  attribute_key text NOT NULL,
  status text NOT NULL,
  entity_id bigint,
  watcher_id bigint,
  entity_ids bigint[],
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- squawk-ignore require-concurrent-index-creation -- empty table at creation
CREATE INDEX IF NOT EXISTS idx_classify_facet_org_slug
  ON public.classify_facet (organization_id, slug);

CREATE OR REPLACE FUNCTION public.sync_classify_facet() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.classify_facet WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO public.classify_facet
    (id, organization_id, slug, name, description, attribute_key, status,
     entity_id, watcher_id, entity_ids, created_by, created_at, updated_at)
  VALUES
    (NEW.id, NEW.organization_id, NEW.slug, NEW.name, NEW.description, NEW.attribute_key, NEW.status,
     NEW.entity_id, NEW.watcher_id, NEW.entity_ids, NEW.created_by,
     COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now()))
  ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id, slug = EXCLUDED.slug, name = EXCLUDED.name,
    description = EXCLUDED.description, attribute_key = EXCLUDED.attribute_key, status = EXCLUDED.status,
    entity_id = EXCLUDED.entity_id, watcher_id = EXCLUDED.watcher_id, entity_ids = EXCLUDED.entity_ids,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_classify_facet
  AFTER INSERT OR UPDATE OR DELETE ON public.event_classifiers
  FOR EACH ROW EXECUTE FUNCTION public.sync_classify_facet();

-- Inline backfill (config-scale table — safe).
INSERT INTO public.classify_facet
  (id, organization_id, slug, name, description, attribute_key, status,
   entity_id, watcher_id, entity_ids, created_by, created_at, updated_at)
SELECT id, organization_id, slug, name, description, attribute_key, status,
       entity_id, watcher_id, entity_ids, created_by,
       COALESCE(created_at, now()), COALESCE(updated_at, now())
FROM public.event_classifiers
ON CONFLICT (id) DO NOTHING;

-- migrate:down

DROP TRIGGER IF EXISTS trg_sync_classify_facet ON public.event_classifiers;
DROP FUNCTION IF EXISTS public.sync_classify_facet();
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.classify_facet;
