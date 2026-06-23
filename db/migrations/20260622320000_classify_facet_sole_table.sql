-- migrate:up

-- P4 FINAL (phases 6a + 7): classify_facet becomes the SOLE classifier table; drop
-- event_classifiers + event_classifier_versions. The vestigial version model is gone — a classifier
-- is just its current config, edited in place on the one row. All READS (6b/6c) and WRITES (this PR)
-- target classify_facet; the mirror triggers that fed it from the old tables are retired.
--
-- 🚨 DO NOT APPLY until reads+writes are universal in prod — do-not-merge CONTRACT, same shape as
-- the 5d / P1 #1466 / P6 #1477 drops. Config-scale tables (not events-scaled), so metadata-only at
-- deploy.

-- 1. classify_facet self-generates its id. It was set = event_classifiers.id by the now-retired
--    mirror; existing ids are preserved (event_classifications references them) and new classifiers
--    get fresh ids past the current max.
CREATE SEQUENCE IF NOT EXISTS classify_facet_id_seq OWNED BY classify_facet.id;
SELECT setval('classify_facet_id_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM classify_facet), 1));
-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration in a transaction
ALTER TABLE classify_facet ALTER COLUMN id SET DEFAULT nextval('classify_facet_id_seq');

-- 2. The watcher-extraction upsert keys on (entity_id, watcher_id, slug); give classify_facet the
--    same NULLS NOT DISTINCT unique event_classifiers had.
-- squawk-ignore disallowed-unique-constraint,prefer-robust-stmts,constraint-missing-not-valid -- config-scale table; brief lock acceptable; dbmate wraps in a transaction
ALTER TABLE classify_facet ADD CONSTRAINT classify_facet_unique_per_insight UNIQUE NULLS NOT DISTINCT (entity_id, watcher_id, slug);

-- 3. Retire the mirror — writers feed classify_facet directly now.
DROP TRIGGER IF EXISTS trg_sync_classify_facet ON event_classifiers;
DROP TRIGGER IF EXISTS trg_sync_classify_facet_config ON event_classifier_versions;
DROP FUNCTION IF EXISTS sync_classify_facet();
DROP FUNCTION IF EXISTS sync_classify_facet_config();

-- 4. current_version_id is meaningless without versions; no code reads it anymore.
ALTER TABLE classify_facet DROP COLUMN IF EXISTS current_version_id;

-- 5. Repoint the output FK off event_classifiers onto classify_facet (same id values, so every row
--    validates). NOT VALID + VALIDATE avoids the ACCESS EXCLUSIVE scan-lock.
--
-- PRE-CLEAN (deploy-safety, flagged in review): VALIDATE aborts the whole migration if even ONE
-- classification references a classifier_id absent from classify_facet (a historical mirror gap).
-- The 5d cascade keeps these synced so this is ~0 rows in practice, but the migration must not abort
-- on a stray orphan. The anti-join is fast (small classify_facet + idx on classifier_id). Run the
-- count on a prod replica first: SELECT count(*) FROM event_classifications ec
--   WHERE NOT EXISTS (SELECT 1 FROM classify_facet cf WHERE cf.id = ec.classifier_id);
-- squawk-ignore prefer-robust-stmts -- dbmate wraps in a transaction
DELETE FROM event_classifications ec
  WHERE NOT EXISTS (SELECT 1 FROM classify_facet cf WHERE cf.id = ec.classifier_id);

ALTER TABLE event_classifications DROP CONSTRAINT IF EXISTS event_classifications_classifier_id_fkey;
ALTER TABLE event_classifications
  ADD CONSTRAINT event_classifications_classifier_id_fkey
  FOREIGN KEY (classifier_id) REFERENCES classify_facet (id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE event_classifications
  VALIDATE CONSTRAINT event_classifications_classifier_id_fkey;

-- 6. Drop the now-orphan source tables (versions first — it FKs classifiers).
-- squawk-ignore ban-drop-table -- the consolidation endpoint; classify_facet is the sole home
DROP TABLE IF EXISTS event_classifier_versions;
-- squawk-ignore ban-drop-table -- ditto
DROP TABLE IF EXISTS event_classifiers;

-- migrate:down

-- Best-effort restore: recreate the two tables + the mirror, repoint the FK back, backfill from
-- classify_facet (one v1 version per classifier). Historical version chains are not recoverable.

CREATE TABLE IF NOT EXISTS event_classifiers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  attribute_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  entity_id bigint,
  entity_ids bigint[],
  watcher_id bigint,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_classifiers_unique_per_insight UNIQUE NULLS NOT DISTINCT (entity_id, watcher_id, slug)
);

CREATE TABLE IF NOT EXISTS event_classifier_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- squawk-ignore adding-foreign-key-constraint,constraint-missing-not-valid -- fresh rollback table, no lock concern
  classifier_id bigint NOT NULL REFERENCES event_classifiers (id) ON DELETE CASCADE,
  version bigint NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  attribute_values jsonb,
  min_similarity numeric,
  fallback_value text,
  preferred_model text,
  extraction_config jsonb,
  change_notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Re-add current_version_id + restore id as a plain column (drop the sequence default).
ALTER TABLE classify_facet ADD COLUMN IF NOT EXISTS current_version_id bigint;
-- squawk-ignore prefer-robust-stmts -- down/rollback path only; dbmate wraps in a transaction
ALTER TABLE classify_facet ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS classify_facet_id_seq;
ALTER TABLE classify_facet DROP CONSTRAINT IF EXISTS classify_facet_unique_per_insight;

-- Backfill the source tables from classify_facet (id preserved).
INSERT INTO event_classifiers (id, organization_id, slug, name, description, attribute_key, status, entity_id, entity_ids, watcher_id, created_by, created_at, updated_at)
OVERRIDING SYSTEM VALUE
SELECT id, organization_id, slug, name, description, attribute_key, status, entity_id, entity_ids, watcher_id, created_by, created_at, updated_at
FROM classify_facet
ON CONFLICT (id) DO NOTHING;

INSERT INTO event_classifier_versions (classifier_id, version, is_current, attribute_values, min_similarity, fallback_value, preferred_model, extraction_config, change_notes, created_by, created_at)
SELECT id, 1, true, attribute_values, min_similarity, fallback_value, preferred_model, extraction_config, 'restored', created_by, created_at
FROM classify_facet;

UPDATE classify_facet cf
SET current_version_id = ecv.id
FROM event_classifier_versions ecv
WHERE ecv.classifier_id = cf.id AND ecv.is_current = true;

-- Repoint the FK back to event_classifiers.
ALTER TABLE event_classifications DROP CONSTRAINT IF EXISTS event_classifications_classifier_id_fkey;
-- squawk-ignore adding-foreign-key-constraint,constraint-missing-not-valid,prefer-robust-stmts -- best-effort rollback; dbmate transaction
ALTER TABLE event_classifications ADD CONSTRAINT event_classifications_classifier_id_fkey FOREIGN KEY (classifier_id) REFERENCES event_classifiers (id) ON DELETE CASCADE;

-- Recreate the mirror functions + triggers (identity + config sync, INSERT/UPDATE/DELETE).
CREATE OR REPLACE FUNCTION sync_classify_facet() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM classify_facet WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO classify_facet (id, organization_id, slug, name, description, attribute_key, status, entity_id, entity_ids, watcher_id, created_by, created_at, updated_at)
  VALUES (NEW.id, NEW.organization_id, NEW.slug, NEW.name, NEW.description, NEW.attribute_key, NEW.status, NEW.entity_id, NEW.entity_ids, NEW.watcher_id, NEW.created_by, NEW.created_at, NEW.updated_at)
  ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id, slug = EXCLUDED.slug, name = EXCLUDED.name,
    description = EXCLUDED.description, attribute_key = EXCLUDED.attribute_key, status = EXCLUDED.status,
    entity_id = EXCLUDED.entity_id, entity_ids = EXCLUDED.entity_ids, watcher_id = EXCLUDED.watcher_id,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_classify_facet_config() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.is_current THEN
    UPDATE classify_facet SET
      current_version_id = NEW.id, attribute_values = NEW.attribute_values,
      min_similarity = NEW.min_similarity, fallback_value = NEW.fallback_value,
      preferred_model = NEW.preferred_model, extraction_config = NEW.extraction_config
    WHERE id = NEW.classifier_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_classify_facet
  AFTER INSERT OR UPDATE OR DELETE ON event_classifiers
  FOR EACH ROW EXECUTE FUNCTION sync_classify_facet();

CREATE TRIGGER trg_sync_classify_facet_config
  AFTER INSERT OR UPDATE ON event_classifier_versions
  FOR EACH ROW EXECUTE FUNCTION sync_classify_facet_config();
