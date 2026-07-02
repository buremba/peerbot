-- migrate:up transaction:false

-- Canvas-on-events: one chain ROOT per (watcher, granularity, period).
-- A watcher window is now a supersede chain of `semantic_type='canvas_state'`
-- events; the chain-root event (supersedes_event_id IS NULL) is the window
-- identity. This partial UNIQUE expression index enforces "at most one root per
-- period" — concurrent completions on N replicas race here and the loser gets a
-- 23505 the write path maps to a 409 (same UX as the retired
-- idx_watcher_windows_unique_period).
--
-- Scoped to semantic_type='canvas_state' so it never collides with the 19k+
-- tab_event/tab_snapshot rows that also carry metadata.window_id for BROWSER
-- windows. CONCURRENTLY (transaction:false, one statement) so building it never
-- locks the high-write events table; squawk requires a CONCURRENTLY index alone
-- in its own file.
--
-- window_start is indexed as the raw canonical text (`metadata->>'window_start'`,
-- always written as a UTC ISO-8601 string via Date.toISOString()) rather than
-- cast to timestamptz: text→timestamptz is STABLE, not IMMUTABLE (it reads the
-- session TimeZone), so it cannot appear in an index expression. Text equality on
-- the canonical string is exactly the uniqueness we need; query predicates that
-- want timestamptz semantics cast in the WHERE clause, which is allowed.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_canvas_chain_root
  ON public.events (
    ((metadata->>'watcher_id')::bigint),
    (metadata->>'granularity'),
    (metadata->>'window_start')
  )
  WHERE semantic_type = 'canvas_state' AND supersedes_event_id IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_canvas_chain_root;
