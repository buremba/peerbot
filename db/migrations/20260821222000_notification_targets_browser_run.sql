-- Link browser-handoff notifications to the durable page-activation run whose
-- lifecycle decides whether the external page can still be populated.
--
-- The request path joins this exact FK by the runs primary key. Historical
-- handoffs are backfilled once here from their Automation parent + target URL;
-- no growing-history search is added to Activity reads.
--
-- The referencing column is indexed because runs ARE deleted in bulk (the
-- stalled-run sweep prunes 1000 terminal runs per tick), and an unindexed
-- ON DELETE SET NULL referent makes every one of those deletes scan
-- notification_targets.
--
-- transaction:false for the CONCURRENTLY index build; every statement is
-- individually rerunnable so a partial failure can retry.

-- migrate:up transaction:false

ALTER TABLE public.notification_targets
  ADD COLUMN IF NOT EXISTS browser_run_id bigint;

-- Heal an INVALID carcass from a failed CONCURRENTLY build so every retry can
-- rebuild it (same shape as 20260815230000).
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_notification_targets_browser_run_id'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_notification_targets_browser_run_id';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_targets_browser_run_id
  ON public.notification_targets (browser_run_id)
  WHERE browser_run_id IS NOT NULL;

-- Older Social Radar notifications already point at the producing Automation
-- run through events.run_id, and its child page-activation run stores the
-- NORMALIZED target URL. The join below reproduces only the query/hash strip of
-- normalizePageActivationUrl, not its trailing-slash trim or the host/default-port
-- canonicalization the URL parser does, so this backfill is best effort: a URL
-- those steps would have rewritten stays NULL and renders as an unlinked handoff.
-- It cannot mislink, because both branches are exact-equality tests.
WITH matched AS (
  SELECT DISTINCT ON (t.event_id, t.user_id)
    t.event_id,
    t.user_id,
    r.id AS browser_run_id
  FROM public.notification_targets t
  JOIN public.events e ON e.id = t.event_id
  JOIN public.runs r
    ON r.organization_id = e.organization_id
   AND r.parent_run_id = e.run_id
   AND r.run_type = 'action'
   AND r.activation_kind = 'page_visit'
   AND r.created_by_user_id = t.user_id
   AND (
     t.browser_url = ANY(r.activation_target_urls)
     OR split_part(split_part(t.browser_url, '#', 1), '?', 1)
          = ANY(r.activation_target_urls)
   )
  WHERE t.browser_url IS NOT NULL
    AND t.browser_run_id IS NULL
  ORDER BY t.event_id, t.user_id, r.id DESC
)
UPDATE public.notification_targets t
SET browser_run_id = matched.browser_run_id
FROM matched
WHERE t.event_id = matched.event_id
  AND t.user_id = matched.user_id
  AND t.browser_run_id IS NULL;

-- ADD CONSTRAINT has no IF NOT EXISTS. Guard it so a partial-failure rerun can
-- safely continue after the column/index/backfill statements above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notification_targets_browser_run_id_fkey'
  ) THEN
    ALTER TABLE public.notification_targets
      ADD CONSTRAINT notification_targets_browser_run_id_fkey
      FOREIGN KEY (browser_run_id) REFERENCES public.runs(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.notification_targets
  VALIDATE CONSTRAINT notification_targets_browser_run_id_fkey;

-- migrate:down transaction:false

ALTER TABLE public.notification_targets
  DROP CONSTRAINT IF EXISTS notification_targets_browser_run_id_fkey;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_notification_targets_browser_run_id;

ALTER TABLE public.notification_targets
  DROP COLUMN IF EXISTS browser_run_id;
