-- migrate:up

-- Timezone-aware, bounded, dedup-safe schedules. All nullable, no backfill:
-- NULL timezone = server time (existing behavior), NULL until_at = recur
-- forever, NULL idempotency_key = no create dedup.
ALTER TABLE scheduled_jobs
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS until_at timestamptz,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- migrate:down

ALTER TABLE scheduled_jobs
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS until_at,
  DROP COLUMN IF EXISTS timezone;
