-- migrate:up transaction:false

-- Canvas-on-events: listing / pagination index over ALL chain members (roots and
-- superseders alike), keyed on the same period columns the write path stamps.
-- Serves get_watchers pagination (ORDER BY window_start DESC) and previous-period
-- lookups without scanning the full events table. Non-unique on purpose — a
-- period has one root but many chain members (edit history).
--
-- Scoped to semantic_type='canvas_state' (must never pattern-match the bare
-- metadata.window_id used by tab_event/tab_snapshot BROWSER rows). CONCURRENTLY
-- (own file, squawk) so the build never locks events.
--
-- window_start indexed as canonical text (see idx_canvas_chain_root) — a UTC
-- ISO-8601 string sorts lexicographically in timestamp order, so DESC text
-- ordering matches DESC chronological ordering for get_watchers pagination.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_canvas_state_listing
  ON public.events (
    ((metadata->>'watcher_id')::bigint),
    (metadata->>'granularity'),
    (metadata->>'window_start') DESC
  )
  WHERE semantic_type = 'canvas_state';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_canvas_state_listing;
