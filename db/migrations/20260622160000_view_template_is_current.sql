-- migrate:up

-- Render-store consolidation, EXPAND phase (1 of 3): fold the
-- view_template_active_tabs pointer table into an is_current flag on
-- view_template_versions (mirrors event_classifier_versions.is_current).
--
-- is_current is maintained by a DB TRIGGER on view_template_active_tabs, so it
-- stays consistent no matter which app replica (old OR new) writes the pointer
-- table during a rolling deploy — no app-level dual-write, no drift, no
-- non-atomic remove. This release only ADDS is_current + the trigger; READS
-- still use view_template_active_tabs. A later release flips reads to is_current;
-- the final release drops view_template_active_tabs (and this trigger, with the
-- app then writing is_current directly).
--
-- Operational cost: view_template_versions / active_tabs are low-volume UI-driven
-- config tables (a handful of rows per org, far under the ~100k threshold). The
-- constant DEFAULT false ADD COLUMN is a metadata-only flip (no rewrite, PG11+);
-- the backfill UPDATE touches only the rows active_tabs points at. (Not measured
-- against prod size, but these are config-scale tables.)

ALTER TABLE public.view_template_versions
    ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;

-- Keep view_template_versions.is_current in lockstep with the
-- view_template_active_tabs pointer (named tabs only — default tabs track current
-- via the parent FK current_view_template_version_id, never is_current). The
-- clear-then-set ordering avoids a transient two-current violation of the partial
-- unique index; concurrent writers for the same tab serialize on the active_tabs
-- unique row, so their triggers fire serially.
CREATE OR REPLACE FUNCTION public.sync_view_template_is_current() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE public.view_template_versions SET is_current = false
        WHERE resource_type = OLD.resource_type AND resource_id = OLD.resource_id
          AND organization_id = OLD.organization_id AND tab_name = OLD.tab_name
          AND is_current = true;
        RETURN OLD;
    END IF;
    UPDATE public.view_template_versions SET is_current = false
    WHERE resource_type = NEW.resource_type AND resource_id = NEW.resource_id
      AND organization_id = NEW.organization_id AND tab_name = NEW.tab_name
      AND is_current = true AND id <> NEW.current_version_id;
    UPDATE public.view_template_versions SET is_current = true
    WHERE id = NEW.current_version_id AND is_current = false;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_view_template_is_current ON public.view_template_active_tabs;
CREATE TRIGGER trg_sync_view_template_is_current
    AFTER INSERT OR UPDATE OR DELETE ON public.view_template_active_tabs
    FOR EACH ROW EXECUTE FUNCTION public.sync_view_template_is_current();

-- Backfill existing pointers (the trigger only fires on future writes).
UPDATE public.view_template_versions v
SET is_current = true
FROM public.view_template_active_tabs t
WHERE t.current_version_id = v.id;

-- migrate:down
DROP TRIGGER IF EXISTS trg_sync_view_template_is_current ON public.view_template_active_tabs;
DROP FUNCTION IF EXISTS public.sync_view_template_is_current();
ALTER TABLE public.view_template_versions DROP COLUMN IF EXISTS is_current;
