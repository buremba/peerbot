-- migrate:up

-- Render-store consolidation, phase 2: the read-flip (resolve_path.fetchTabs and
-- manage_view_templates.handleGet now read named tabs + their display order from
-- view_template_versions.is_current instead of view_template_active_tabs) needs
-- the is_current version's tab_order to match the active pointer's.
--
-- Phase 1's trigger synced only is_current. A rollback re-points to an OLDER
-- version (which carries its own historical tab_order) without touching
-- active_tabs.tab_order, so reading order from the version could differ from the
-- legacy active_tabs order. Extend the trigger to also sync tab_order onto the
-- current version, and backfill it. (The set-current UPDATE drops the prior
-- `AND is_current = false` no-op guard so a tab_order-only / re-point update still
-- refreshes the order; re-setting is_current=true on the already-current row is
-- idempotent and the clear-first ordering keeps the partial unique index safe.)

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

-- Backfill display order onto the current version from the active pointer.
UPDATE public.view_template_versions v
SET tab_order = t.tab_order
FROM public.view_template_active_tabs t
WHERE t.current_version_id = v.id AND v.tab_order IS DISTINCT FROM t.tab_order;

-- migrate:down

-- Revert the trigger to phase 1's is_current-only function. The backfilled
-- tab_order values on version rows are intentionally NOT reverted (there's no
-- clean inverse, and they're harmless: phase-1 reads tab_order from
-- view_template_active_tabs, not from the version row, so the synced value is
-- ignored once reads roll back via the app).
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
