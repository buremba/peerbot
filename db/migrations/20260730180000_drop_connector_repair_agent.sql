-- Drop the connector repair-agent subsystem.
-- Remediation is now: feed hard auto-pause → feed.auto_paused Behavior signal
-- (+ optional out-of-the-box Behavior). Columns are unused after QUERYABLE_SCHEMA
-- and application code stopped reading them.

-- migrate:up

-- squawk-ignore ban-drop-column
ALTER TABLE public.feeds
  DROP COLUMN IF EXISTS repair_agent_id,
  DROP COLUMN IF EXISTS repair_thread_id,
  DROP COLUMN IF EXISTS repair_attempt_count,
  DROP COLUMN IF EXISTS last_repair_at,
  DROP COLUMN IF EXISTS last_repair_post_hash;

-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS public.feeds_open_repair_thread_uniq;

-- squawk-ignore ban-drop-column
ALTER TABLE public.connector_definitions
  DROP COLUMN IF EXISTS default_repair_agent_id;

-- migrate:down
ALTER TABLE public.feeds
  ADD COLUMN IF NOT EXISTS repair_agent_id text,
  ADD COLUMN IF NOT EXISTS repair_thread_id text,
  ADD COLUMN IF NOT EXISTS repair_attempt_count bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS last_repair_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_repair_post_hash text;

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS feeds_open_repair_thread_uniq
  ON public.feeds (id)
  WHERE (repair_thread_id IS NOT NULL);

ALTER TABLE public.connector_definitions
  ADD COLUMN IF NOT EXISTS default_repair_agent_id text;
