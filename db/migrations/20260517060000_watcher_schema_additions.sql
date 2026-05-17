-- migrate:up

-- Adds the columns needed by the device-aware watcher dispatcher (see
-- lobu-ai/lobu#798 / #799):
--
-- * device_worker_id        — pin a watcher to a specific device worker
--                              (when its inputs live on that device).
-- * agent_kind              — overrides the owning agent's default kind for
--                              this watcher (e.g. "background", "notifier").
-- * notification_channel    — where firings surface: canvas, OS notification,
--                              or both.
-- * notification_priority   — priority class used by the dispatcher's
--                              interrupt budget.
-- * min_cooldown_seconds    — minimum seconds between two firings of the
--                              same watcher (0 = no cooldown).
-- * last_fired_at           — last time this watcher actually dispatched
--                              a notification/canvas item.
--
-- Also adds device_workers.notification_budget_per_day for the per-device
-- global interrupt budget. 10/day is a placeholder default; tune later.

ALTER TABLE public.watchers
  ADD COLUMN device_worker_id uuid REFERENCES public.device_workers(id),
  ADD COLUMN agent_kind text,
  ADD COLUMN notification_channel text NOT NULL DEFAULT 'canvas',
  ADD COLUMN notification_priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN min_cooldown_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN last_fired_at timestamp with time zone;

ALTER TABLE public.watchers
  ADD CONSTRAINT watchers_notification_channel_check
    CHECK (notification_channel IN ('canvas', 'notification', 'both'));

ALTER TABLE public.watchers
  ADD CONSTRAINT watchers_notification_priority_check
    CHECK (notification_priority IN ('low', 'normal', 'high'));

ALTER TABLE public.watchers
  ADD CONSTRAINT watchers_min_cooldown_seconds_nonneg
    CHECK (min_cooldown_seconds >= 0);

CREATE INDEX IF NOT EXISTS idx_watchers_device_worker_id
  ON public.watchers (device_worker_id)
  WHERE device_worker_id IS NOT NULL;

ALTER TABLE public.device_workers
  ADD COLUMN notification_budget_per_day integer NOT NULL DEFAULT 10;

ALTER TABLE public.device_workers
  ADD CONSTRAINT device_workers_notification_budget_per_day_nonneg
    CHECK (notification_budget_per_day >= 0);

-- migrate:down

ALTER TABLE public.device_workers
  DROP CONSTRAINT IF EXISTS device_workers_notification_budget_per_day_nonneg;

ALTER TABLE public.device_workers
  DROP COLUMN IF EXISTS notification_budget_per_day;

DROP INDEX IF EXISTS public.idx_watchers_device_worker_id;

ALTER TABLE public.watchers
  DROP CONSTRAINT IF EXISTS watchers_min_cooldown_seconds_nonneg;

ALTER TABLE public.watchers
  DROP CONSTRAINT IF EXISTS watchers_notification_priority_check;

ALTER TABLE public.watchers
  DROP CONSTRAINT IF EXISTS watchers_notification_channel_check;

ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS last_fired_at,
  DROP COLUMN IF EXISTS min_cooldown_seconds,
  DROP COLUMN IF EXISTS notification_priority,
  DROP COLUMN IF EXISTS notification_channel,
  DROP COLUMN IF EXISTS agent_kind,
  DROP COLUMN IF EXISTS device_worker_id;
