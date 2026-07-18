-- migrate:up
--
-- Platform used to invent `0 */6 * * *` when create_feed omitted schedule.
-- That is removed: omit/null = manual-only. Clear the historical default so
-- existing feeds stop auto-polling until an explicit cron is set again
-- (UI or lobu.config schedule: "...").
--
-- Also clear next_run_at so CheckDueFeeds will not re-enqueue them.

UPDATE public.feeds
SET
  schedule = NULL,
  next_run_at = NULL,
  updated_at = NOW()
WHERE schedule = '0 */6 * * *'
  AND deleted_at IS NULL;

-- migrate:down
-- Irreversible data cleanup: cannot restore which feeds had the default vs
-- an intentional 6-hour cron. No-op on down.
SELECT 1;
