-- migrate:up

-- Partial index supporting the connector-lane stale-run reaper. The sweeper
-- query in reapStaleRuns() (packages/server/src/scheduled/check-stalled-executions.ts)
-- filters runs in the in-progress states (`claimed`, `running`) whose
-- `last_heartbeat_at` is older than the configured threshold. Without this
-- index every reaper tick does a full scan of `runs`.
--
-- Restricted to the connector lanes (sync, action, embed_backfill, auth). The
-- lobu-queue lanes (chat_message, schedule, agent_run, internal, task) have
-- their own per-claim sweep inside RunsQueue keyed on `claimed_at`, not
-- `last_heartbeat_at`. The `watcher` lane has a dedicated 2h-TTL sweep in
-- watchers/automation.ts.

CREATE INDEX IF NOT EXISTS idx_runs_heartbeat_inflight
    ON public.runs (last_heartbeat_at)
    WHERE status IN ('claimed', 'running')
      AND run_type IN ('sync', 'action', 'embed_backfill', 'auth');

-- migrate:down

DROP INDEX IF EXISTS public.idx_runs_heartbeat_inflight;
