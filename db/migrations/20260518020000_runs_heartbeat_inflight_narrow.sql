-- migrate:up

-- Narrow the partial index `idx_runs_heartbeat_inflight` to the lanes that
-- actually emit `client.heartbeat()` from the connector-worker executor.
-- The previous index (20260518010000) covered all four connector lanes
-- (sync, action, embed_backfill, auth), but only `sync` and `auth` runs call
-- heartbeat() in packages/connector-worker/src/daemon/executor.ts. Action
-- runs (executeActionRun) and embed_backfill runs (executeEmbedBackfillRun)
-- never heartbeat, so the reaper's heartbeat-based WHERE clause would mark
-- any action/embed_backfill run lasting longer than the stale threshold
-- (default 120s) as `timeout` while it is still executing.
--
-- Drop and recreate to also align the index with the reaper query in
-- packages/server/src/scheduled/check-stalled-executions.ts, which is
-- updated to filter on the narrower lane set in the same change.
--
-- Follow-ups (tracked as separate issues):
--   1. Wire `client.heartbeat()` into executeActionRun + executeEmbedBackfillRun
--      so those lanes can be safely reaped.
--   2. Wire heartbeat into the Chrome/Owletto browser-worker run path.

DROP INDEX IF EXISTS public.idx_runs_heartbeat_inflight;

CREATE INDEX IF NOT EXISTS idx_runs_heartbeat_inflight
    ON public.runs (last_heartbeat_at)
    WHERE status IN ('claimed', 'running')
      AND run_type IN ('sync', 'auth');

-- migrate:down

DROP INDEX IF EXISTS public.idx_runs_heartbeat_inflight;

CREATE INDEX IF NOT EXISTS idx_runs_heartbeat_inflight
    ON public.runs (last_heartbeat_at)
    WHERE status IN ('claimed', 'running')
      AND run_type IN ('sync', 'action', 'embed_backfill', 'auth');
