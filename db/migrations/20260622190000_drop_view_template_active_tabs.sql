-- migrate:up

-- Render-store consolidation, phase 3c (final): drop view_template_active_tabs and
-- its sync trigger. As of phase 3b no app code reads OR writes active_tabs (reads
-- moved to is_current in phase 2; writes removed in phase 3b), so the table + the
-- now-dormant trigger are dead. Safe under N>1: ships after phase 3b is universal,
-- so no pod touches active_tabs. DROP TABLE cascades the trigger on it, its
-- sequence, and the pkey/unique/fk constraints.

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.view_template_active_tabs;
DROP FUNCTION IF EXISTS public.sync_view_template_is_current();

-- migrate:down

-- Recreate the pointer table + sync trigger and reconstruct it from the current
-- named-tab versions (is_current), so a rollback to phase 3a/2 code (which reads
-- and/or writes active_tabs) sees correct data.
-- Rollback recreate: structure + unique key + backfill are what older (phase
-- 3a/2) code needs from active_tabs. The original FK to view_template_versions(id)
-- is omitted here (it required integer columns to match; bigint avoids the
-- prefer-bigint lint and the FK is not load-bearing for a transient rollback
-- table). The unique key is the one constraint older code's ON CONFLICT relies on.
CREATE TABLE IF NOT EXISTS public.view_template_active_tabs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    organization_id text NOT NULL,
    tab_name text NOT NULL,
    tab_order bigint DEFAULT 0,
    current_version_id bigint NOT NULL,
    CONSTRAINT view_template_active_tabs_resource_type_check
        CHECK (resource_type = ANY (ARRAY['entity_type'::text, 'entity'::text])),
    CONSTRAINT view_template_active_tabs_unique
        UNIQUE (resource_type, resource_id, organization_id, tab_name)
);

-- Reconstruct pointers from the current named-tab versions BEFORE recreating the
-- trigger (so the backfill insert doesn't fire it).
INSERT INTO public.view_template_active_tabs
    (resource_type, resource_id, organization_id, tab_name, tab_order, current_version_id)
SELECT resource_type, resource_id, organization_id, tab_name, tab_order, id
FROM public.view_template_versions
WHERE tab_name IS NOT NULL AND is_current = true;

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
    UPDATE public.view_template_versions
    SET is_current = true, tab_order = NEW.tab_order
    WHERE id = NEW.current_version_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_view_template_is_current
    AFTER INSERT OR UPDATE OR DELETE ON public.view_template_active_tabs
    FOR EACH ROW EXECUTE FUNCTION public.sync_view_template_is_current();
