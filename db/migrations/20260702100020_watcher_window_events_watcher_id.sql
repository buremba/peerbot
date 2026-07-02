-- migrate:up

-- Canvas-on-events: denormalize watcher_id onto watcher_window_events so the
-- inputs link table can be re-keyed to canvas root event ids without a join back
-- through watcher_windows (which is dropped at the end state). The window_id
-- column continues to point at the window identity (soon the canvas root event
-- id); watcher_id lets listing/pagination stay on typed columns.
--
-- Backfilled inline from watcher_windows in the same migration: prod has only
-- ~413 watcher_window_events rows, so a single correlated UPDATE is safe and
-- keeps un-flipped readers correct during the dual-write release.
ALTER TABLE public.watcher_window_events
  ADD COLUMN IF NOT EXISTS watcher_id bigint;

UPDATE public.watcher_window_events wwe
SET watcher_id = ww.watcher_id
FROM public.watcher_windows ww
WHERE wwe.window_id = ww.id
  AND wwe.watcher_id IS NULL;

-- migrate:down

ALTER TABLE public.watcher_window_events
  DROP COLUMN IF EXISTS watcher_id;
