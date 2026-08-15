-- Materialized browser-handoff marker on notification_targets.
--
-- The attention feed needs "undismissed browser-handoff notifications" without
-- scanning append-only events for a JSON predicate. Mirror the browser_url
-- onto the per-user bounded delivery row (written at creation) so the filter is
-- an indexed column, not an unindexed scan of growing history.
--
-- transaction:false for the CONCURRENTLY index build; every statement is
-- individually rerunnable so a partial failure can retry.

-- migrate:up transaction:false
ALTER TABLE public.notification_targets
  ADD COLUMN IF NOT EXISTS browser_url text;

-- Heal an INVALID carcass from a failed CONCURRENTLY build so every retry can
-- rebuild it (same shape as 20260812010000 / 20260813123000).
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_notification_targets_browser_url'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_notification_targets_browser_url';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_targets_browser_url
  ON public.notification_targets (user_id, delivered_at DESC)
  WHERE browser_url IS NOT NULL;

-- Backfill: existing browser-handoff notifications carry the URL only in the
-- events row's metadata; copy it onto their delivery rows so the new filter is
-- accurate immediately, not just for rows written after deploy.
UPDATE public.notification_targets t
SET browser_url = e.metadata->>'browser_url'
FROM events e
WHERE t.event_id = e.id
  AND t.browser_url IS NULL
  AND e.metadata ? 'browser_url'
  AND e.metadata->>'browser_url' <> '';

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS public.idx_notification_targets_browser_url;

ALTER TABLE public.notification_targets
  DROP COLUMN IF EXISTS browser_url;
