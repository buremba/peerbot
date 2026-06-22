-- migrate:up

-- Watcher-render consolidation phase 1 (expand). Mirror watcher_versions.json_template
-- (DISPLAY-ONLY — verified the worker never reads it; the poll/complete-window path
-- ships only prompt + extraction_schema) into the unified view_template_versions
-- store, so the watcher render lives in ONE place. Keyed by the watcher GROUP:
-- resource_type='watcher', resource_id = watcher_versions.watcher_id (the group-root
-- watcher id), organization_id resolved from the root watcher. A DB trigger keeps it
-- in sync from every replica (the active_tabs lesson: trigger > app dual-write, which
-- drifts on rolling deploys). Versions with NULL json_template (AutoRenderer watchers)
-- are skipped. No is_current needed — display reads a SPECIFIC selected version, not a
-- current-flag. Reads flip in phase 2; the watcher_versions.json_template column drops
-- in phase 3.

-- Widen the resource_type CHECK to allow 'watcher'. It's a superset, so NOT VALID +
-- VALIDATE avoids an AccessExclusive scan-lock (all existing rows trivially pass).
ALTER TABLE public.view_template_versions
  DROP CONSTRAINT IF EXISTS view_template_versions_resource_type_check;
-- squawk-ignore prefer-robust-stmts -- CHECK can't be ADD ... IF NOT EXISTS; runs once
ALTER TABLE public.view_template_versions
  ADD CONSTRAINT view_template_versions_resource_type_check
  CHECK (resource_type = ANY (ARRAY['entity_type'::text, 'entity'::text, 'watcher'::text])) NOT VALID;
ALTER TABLE public.view_template_versions
  VALIDATE CONSTRAINT view_template_versions_resource_type_check;

CREATE OR REPLACE FUNCTION public.mirror_watcher_render() RETURNS trigger AS $$
DECLARE
  v_org text;
BEGIN
  -- Re-parenting: on group-root deletion with surviving siblings, the version chain
  -- is re-pointed to a new root (UPDATE watcher_versions SET watcher_id = new_root,
  -- entity-management.ts). That changes the mirror KEY (resource_id = watcher_id), so
  -- drop the stale old-key row; the INSERT below re-creates it under the new root.
  IF TG_OP = 'UPDATE' AND NEW.watcher_id IS DISTINCT FROM OLD.watcher_id THEN
    DELETE FROM public.view_template_versions
    WHERE resource_type = 'watcher' AND resource_id = OLD.watcher_id::text
      AND tab_name IS NULL AND version = OLD.version;
  END IF;
  -- No template: AutoRenderer (born NULL) OR a template cleared by an UPDATE. On an
  -- UPDATE-to-NULL, drop any stale mirror at this key so reads stay equivalent (old
  -- pods would read NULL from watcher_versions; the mirror must not keep a stale row).
  IF NEW.json_template IS NULL THEN
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM public.view_template_versions
      WHERE resource_type = 'watcher' AND resource_id = NEW.watcher_id::text
        AND tab_name IS NULL AND version = NEW.version;
    END IF;
    RETURN NEW;
  END IF;
  -- watcher_versions.watcher_id is the group-root watcher id; the org lives on that
  -- root watcher row. If the root is gone, the render has no home org — skip.
  SELECT organization_id INTO v_org FROM public.watchers WHERE id = NEW.watcher_id;
  IF v_org IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.view_template_versions
    (resource_type, resource_id, organization_id, version, tab_name, json_template, created_by)
  VALUES
    ('watcher', NEW.watcher_id::text, v_org, NEW.version, NULL, NEW.json_template, NEW.created_by)
  ON CONFLICT (resource_type, resource_id, organization_id, tab_name, version)
    DO UPDATE SET json_template = EXCLUDED.json_template;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mirror_watcher_render
  AFTER INSERT OR UPDATE OF json_template, watcher_id ON public.watcher_versions
  FOR EACH ROW EXECUTE FUNCTION public.mirror_watcher_render();

-- Backfill existing watcher renders (org via the group-root watcher).
INSERT INTO public.view_template_versions
  (resource_type, resource_id, organization_id, version, tab_name, json_template, created_by)
SELECT 'watcher', wv.watcher_id::text, w.organization_id, wv.version, NULL, wv.json_template, wv.created_by
FROM public.watcher_versions wv
JOIN public.watchers w ON w.id = wv.watcher_id
WHERE wv.json_template IS NOT NULL
ON CONFLICT (resource_type, resource_id, organization_id, tab_name, version) DO NOTHING;

-- migrate:down

DROP TRIGGER IF EXISTS trg_mirror_watcher_render ON public.watcher_versions;
DROP FUNCTION IF EXISTS public.mirror_watcher_render();
DELETE FROM public.view_template_versions WHERE resource_type = 'watcher';
ALTER TABLE public.view_template_versions
  DROP CONSTRAINT IF EXISTS view_template_versions_resource_type_check;
-- squawk-ignore prefer-robust-stmts -- CHECK can't be ADD ... IF NOT EXISTS; runs once
ALTER TABLE public.view_template_versions
  ADD CONSTRAINT view_template_versions_resource_type_check
  CHECK (resource_type = ANY (ARRAY['entity_type'::text, 'entity'::text])) NOT VALID;
ALTER TABLE public.view_template_versions
  VALIDATE CONSTRAINT view_template_versions_resource_type_check;
