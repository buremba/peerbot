-- migrate:up

-- Add trusted, scheduler-owned chat delivery metadata for wake_agent jobs.
-- Nullable JSONB column only, no default/backfill: metadata-only catalog change
-- on Postgres, O(1) regardless of scheduled_jobs size.
ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS delivery_context jsonb;

-- migrate:down

ALTER TABLE public.scheduled_jobs
  DROP COLUMN IF EXISTS delivery_context;
