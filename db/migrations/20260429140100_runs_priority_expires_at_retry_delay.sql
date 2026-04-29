-- migrate:up

-- Phase 10 of Redis -> Postgres migration: honor the caller-supplied
-- queue options (priority, expireInSeconds, retryDelay) that RunsQueue
-- previously dropped on the floor.
--
-- 1. priority: int, default 0; claim ORDER BY priority DESC, run_at ASC, id ASC.
-- 2. expires_at: row-level TTL. Claim filter excludes expired rows; the
--    periodic cleanup task deletes them.
-- 3. retry_delay_seconds: when set, scheduleRetry uses fixed-delay backoff
--    instead of exponential. NULL falls back to the existing exponential
--    cap-300s curve.

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS retry_delay_seconds integer;

-- Refresh the lobu-claim index so priority + run_at decide claim order.
DROP INDEX IF EXISTS public.runs_lobu_claim_idx;

CREATE INDEX IF NOT EXISTS runs_lobu_claim_idx
    ON public.runs (run_type, queue_name, priority DESC, run_at ASC, id ASC)
    WHERE status = 'pending'
      AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal');

CREATE INDEX IF NOT EXISTS runs_expires_at_idx
    ON public.runs (expires_at)
    WHERE expires_at IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.runs_expires_at_idx;
DROP INDEX IF EXISTS public.runs_lobu_claim_idx;

CREATE INDEX IF NOT EXISTS runs_lobu_claim_idx
    ON public.runs (run_type, queue_name, run_at)
    WHERE status = 'pending'
      AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal');

ALTER TABLE public.runs
    DROP COLUMN IF EXISTS retry_delay_seconds,
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS priority;
