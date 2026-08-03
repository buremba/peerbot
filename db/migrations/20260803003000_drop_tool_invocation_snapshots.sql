-- migrate:up

-- Exact requests for run_sdk, query_sdk, and query_sql now live directly on
-- their append-only audit event as `payload_data.request`. Generic read paths
-- strip that key; `read_knowledge` restores it only for the author or an admin.
-- Bodies are bounded per row but no longer expire. Cancel pending sweep ticks;
-- old pods may seed another during rollout, which the unknown-handler path
-- fails through the normal retry budget.
UPDATE public.runs
SET status = 'cancelled',
    completed_at = now(),
    error_message = 'Task retired: requests are stored on audit events'
WHERE run_type = 'task'
  AND queue_name = 'task'
  AND action_key = 'sweep-tool-invocation-snapshots'
  AND status = 'pending';

-- The snapshot bodies were derived, short-lived copies. Existing audit event
-- rows remain intact; their old bodies are intentionally discarded.
-- squawk-ignore ban-drop-table -- every reader and writer is removed in this change
DROP TABLE IF EXISTS public.tool_invocation_snapshots;

-- migrate:down

-- Recreate only the empty storage structure. Dropped request bodies are not
-- recoverable, and the rolled-back app will seed a fresh retention cron row.
CREATE TABLE IF NOT EXISTS public.tool_invocation_snapshots (
  event_id bigint PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- squawk-ignore require-concurrent-index-creation -- empty table created immediately above
CREATE INDEX IF NOT EXISTS tool_invocation_snapshots_created_at
  ON public.tool_invocation_snapshots (created_at);
