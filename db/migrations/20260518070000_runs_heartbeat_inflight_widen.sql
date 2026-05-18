-- migrate:up

-- Widen the partial index `idx_runs_heartbeat_inflight` back to all four
-- connector lanes (sync, action, embed_backfill, auth) now that the
-- action + embed_backfill executors in
-- packages/connector-worker/src/daemon/executor.ts actually emit
-- `client.heartbeat()` (lobu#860). The reaper WHERE clause in
-- packages/server/src/scheduled/check-stalled-executions.ts mirrors this
-- set so the bulk UPDATE keeps using this partial index.
--
-- History:
--   20260518010000 — created with the wide four-lane set.
--   20260518020000 — narrowed to (sync, auth) because action +
--                    embed_backfill weren't heartbeating; in-flight runs
--                    were being marked `timeout` mid-flight after 120s.
--   20260518070000 — this — wide again, paired with the executor change
--                    that makes those lanes heartbeat.

DROP INDEX IF EXISTS public.idx_runs_heartbeat_inflight;

CREATE INDEX IF NOT EXISTS idx_runs_heartbeat_inflight
    ON public.runs (last_heartbeat_at)
    WHERE status IN ('claimed', 'running')
      AND run_type IN ('sync', 'action', 'embed_backfill', 'auth');

-- migrate:down

DROP INDEX IF EXISTS public.idx_runs_heartbeat_inflight;

CREATE INDEX IF NOT EXISTS idx_runs_heartbeat_inflight
    ON public.runs (last_heartbeat_at)
    WHERE status IN ('claimed', 'running')
      AND run_type IN ('sync', 'auth');
