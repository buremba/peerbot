-- migrate:up

-- Windows-as-events consolidation (P6) phase 1 (expand). Introduce a relational
-- event_edges table that will replace watcher_window_events (membership) + the window
-- hierarchy (parent_window_id / source_window_ids). Phase 1 covers ONLY 'membership' edges
-- (the watcher_window_events replacement) — the content-search consumers need these. A
-- trigger populates new edges from every watcher_window_events INSERT; historic rows are
-- backfilled OUT OF BAND (scripts/backfill-event-edges.sh), never inline (watcher_window_events
-- is events-scaled ~3-5M rows — an in-hook UPDATE is the docs/MIGRATIONS.md outage pattern).
--
-- OPERATIONAL COST: O(1) at deploy — CREATE TABLE (empty) + two indexes on the empty table
-- (plain CREATE INDEX is instant when empty) + a trigger. No table rewrite, no hot-table scan.
--
-- ORG SCOPING (verified — cross-org-leak surface): watcher_window_events has NO
-- organization_id; the edge's org resolves via window -> watcher_windows.watcher_id ->
-- watchers.organization_id (the window's owning watcher). If the org can't be resolved
-- (orphan window/watcher), the edge is SKIPPED rather than guessing — no cross-org leak.
-- watcher_id_hint = the window's watcher_id, matching the exclude_watcher_id consumer's
-- `watcher_windows.watcher_id = $N` filter (content-scoring.ts / visibility.ts).

CREATE TABLE IF NOT EXISTS public.event_edges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL,
  -- parent_event_id currently holds watcher_windows.id (the window). Named forward for
  -- windows-as-events, where the window becomes an events.id; child_event_id is events.id.
  parent_event_id bigint NOT NULL,
  child_event_id bigint NOT NULL,
  edge_type text NOT NULL,
  -- watcher_id_hint stores watcher_windows.watcher_id (integer); bigint for lint + future width.
  watcher_id_hint bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_edges_unique UNIQUE (parent_event_id, child_event_id, edge_type)
);

-- exclude_watcher_id / visibility: NOT EXISTS by (child content event, watcher) — the hot
-- read-knowledge() filter. Partial on the membership edge type. Plain (non-concurrent) index
-- is instant here: the table is empty at creation (backfill is out-of-band, post-deploy).
-- squawk-ignore require-concurrent-index-creation -- empty table at creation
CREATE INDEX IF NOT EXISTS idx_event_edges_membership_child
  ON public.event_edges (child_event_id, watcher_id_hint)
  WHERE edge_type = 'membership';
-- squawk-ignore require-concurrent-index-creation -- empty table at creation
CREATE INDEX IF NOT EXISTS idx_event_edges_parent
  ON public.event_edges (parent_event_id, edge_type);

-- SYNC (not just populate): watcher_window_events rows are also DELETEd — on window-replace
-- (complete-window.ts) and entity deletion (entity-management.ts), plus the FK cascade from
-- watcher_windows. The membership edge must track BOTH so event_edges stays an accurate mirror
-- (required before the phase-2 read flip — a stale edge would wrongly exclude live content).
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
  -- Can't resolve the owning org (orphan) -> skip rather than guess (no cross-org leak).
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

-- migrate:down

DROP TRIGGER IF EXISTS trg_sync_event_edge_membership ON public.watcher_window_events;
DROP FUNCTION IF EXISTS public.sync_event_edge_membership();
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.event_edges;
