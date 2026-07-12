-- migrate:up transaction:false

-- Agent history reloads inspect the newest terminal thread_response row for an
-- organization. runs retains every streamed response row, so idx_runs_org alone
-- still leaves Postgres filtering and sorting the full retained org history.
-- Keep the ordered index limited to rows the history query can consume.
-- CONCURRENTLY avoids blocking writes to the hot runs queue.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_thread_response_history
  ON public.runs (organization_id, id DESC)
  WHERE run_type = 'chat_message'
    AND queue_name = 'thread_response'
    AND status IN ('pending', 'completed', 'failed')
    AND action_input IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_thread_response_history;
