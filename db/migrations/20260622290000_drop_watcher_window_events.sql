-- migrate:up

-- Windows-as-events (P6) phase 4 (CONTRACT): watcher_window_events is retired — window membership
-- lives in event_edges (parent_event_id=window, child_event_id=content, edge_type='membership',
-- watcher_id_hint). All reads (3a-3d) + writes (3e) now use event_edges; the phase-1 mirror trigger
-- is redundant. watcher_windows SURVIVES (its payload + the FK deps).
--
-- 🚨 DO NOT APPLY until BOTH WATCHER_WINDOWS_VIA_EVENT_EDGES (reads) AND
-- WATCHER_WINDOWS_WRITE_VIA_EVENT_EDGES (writes) are UNIVERSAL in prod and
-- scripts/backfill-event-edges.sh is complete. expand->contract release N+1.

DROP TRIGGER IF EXISTS trg_sync_event_edge_membership ON public.watcher_window_events;
DROP FUNCTION IF EXISTS public.sync_event_edge_membership();

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.watcher_window_events;

-- migrate:down

-- Restore the membership junction + the phase-1 mirror trigger. NOTE: the membership DATA lives in
-- event_edges and is NOT moved back by this down (the trigger would re-mirror future writes only).
CREATE TABLE IF NOT EXISTS public.watcher_window_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_id bigint NOT NULL REFERENCES public.watcher_windows(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT watcher_window_events_window_event_key UNIQUE (window_id, event_id)
);

CREATE OR REPLACE FUNCTION public.sync_event_edge_membership() RETURNS trigger AS $$
DECLARE
  v_watcher_id integer;
  v_org text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.event_edges
    WHERE edge_type = 'membership'
      AND parent_event_id = OLD.window_id AND child_event_id = OLD.event_id;
    RETURN OLD;
  END IF;
  SELECT ww.watcher_id, w.organization_id INTO v_watcher_id, v_org
  FROM public.watcher_windows ww
  JOIN public.watchers w ON w.id = ww.watcher_id
  WHERE ww.id = NEW.window_id;
  IF v_org IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.event_edges
    (organization_id, parent_event_id, child_event_id, edge_type, watcher_id_hint, created_at)
  VALUES
    (v_org, NEW.window_id, NEW.event_id, 'membership', v_watcher_id, COALESCE(NEW.created_at, now()))
  ON CONFLICT (parent_event_id, child_event_id, edge_type) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_event_edge_membership
  AFTER INSERT OR DELETE ON public.watcher_window_events
  FOR EACH ROW EXECUTE FUNCTION public.sync_event_edge_membership();
