-- migrate:up

-- IANA zone the cron-style `schedule` is evaluated in (same semantics as
-- scheduled_jobs.timezone from #1866). NULL = server time, existing behavior.
ALTER TABLE watchers
  ADD COLUMN IF NOT EXISTS timezone text;

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS timezone text;

-- migrate:down

ALTER TABLE feeds
  DROP COLUMN IF EXISTS timezone;

ALTER TABLE watchers
  DROP COLUMN IF EXISTS timezone;
