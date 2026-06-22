-- migrate:up

-- Watcher-render fold phase 3b: the app now writes the render DIRECTLY into
-- view_template_versions (phase 3a, proven standalone by a trigger-disabled test) on
-- every replica, so the mirror trigger is retired. Safe after phase 3a is universal:
-- 3a pods direct-write (don't rely on the trigger). The watcher_versions.json_template
-- write is dropped from the app INSERTs + the create_version carry-forward read is
-- flipped to the store in this same release; the column drops in phase 4.

DROP TRIGGER IF EXISTS trg_mirror_watcher_render ON public.watcher_versions;
DROP FUNCTION IF EXISTS public.mirror_watcher_render();

-- migrate:down

-- Backfill watcher_versions.json_template from the store for rows created while phase 3b
-- was active (the app stopped writing the source column). Without this, rolling back to
-- phase-3a code — which reads/carries-forward the source column — would lose those
-- renders. Runs before the trigger is recreated so it doesn't fire it.
UPDATE public.watcher_versions wv
SET json_template = vtv.json_template
FROM public.view_template_versions vtv
WHERE vtv.resource_type = 'watcher' AND vtv.resource_id = wv.watcher_id::text
  AND vtv.version = wv.version AND vtv.tab_name IS NULL
  AND wv.json_template IS NULL;

-- Recreate the phase-1 mirror trigger (mirror on INSERT/UPDATE, re-key on watcher_id
-- change, delete-stale on templated->NULL update).
CREATE OR REPLACE FUNCTION public.mirror_watcher_render() RETURNS trigger AS $$
DECLARE
  v_org text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.watcher_id IS DISTINCT FROM OLD.watcher_id THEN
    DELETE FROM public.view_template_versions
    WHERE resource_type = 'watcher' AND resource_id = OLD.watcher_id::text
      AND tab_name IS NULL AND version = OLD.version;
  END IF;
  IF NEW.json_template IS NULL THEN
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM public.view_template_versions
      WHERE resource_type = 'watcher' AND resource_id = NEW.watcher_id::text
        AND tab_name IS NULL AND version = NEW.version;
    END IF;
    RETURN NEW;
  END IF;
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
