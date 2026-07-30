-- migrate:up

-- Behavior listing was derived at read time: `agent-thread-list` ran a
-- leading-wildcard `LIKE '%\_watcher\_%\_run\_%'`, per-row `regexp_match`, and
-- `GROUP BY` over `agent_transcript_snapshot` once per agent on every sidebar
-- render. The scan grew with the append-only run history.
--
-- It was also stale: archiving a Behavior does not unmake its past runs, and
-- the derive path did not filter on the current Behavior status.
--
-- The fix is one column on the Behavior itself, not a row in another table.
-- `watchers` is a bounded config table, so `status` and `name` are read live at
-- listing time — which is why archive and rename need no synchronisation at all.
ALTER TABLE public.watchers
  ADD COLUMN IF NOT EXISTS last_run_completed_at timestamptz;

-- Migrations run before the app deployment changes, so old replicas can still
-- complete runs after the backfill. Materialize at the database boundary where
-- every completion writer converges; the run transition and stamp then succeed
-- or fail in one transaction, with no compatibility window or reconciliation.
CREATE OR REPLACE FUNCTION public.stamp_watcher_last_run_completed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.watchers
  SET last_run_completed_at = GREATEST(
        COALESCE(last_run_completed_at, NEW.completed_at),
        NEW.completed_at
      )
  WHERE id = NEW.watcher_id
    AND organization_id = NEW.organization_id;
  RETURN NEW;
END;
$$;

-- The embedded migrator can replay SQL before recording its ledger row.
DROP TRIGGER IF EXISTS stamp_watcher_last_run_completed_at ON public.runs;
CREATE TRIGGER stamp_watcher_last_run_completed_at
  AFTER INSERT OR UPDATE OF
    status, completed_at, watcher_id, run_type, organization_id
  ON public.runs
  FOR EACH ROW
  WHEN (
    NEW.run_type = 'behavior'
    AND NEW.status = 'completed'
    AND NEW.watcher_id IS NOT NULL
    AND NEW.completed_at IS NOT NULL
  )
  EXECUTE FUNCTION public.stamp_watcher_last_run_completed_at();

-- Serves the listing read exactly: equality on (organization_id, agent_id),
-- ordered by the timestamp, with the two filters folded into the predicate.
-- squawk-ignore require-concurrent-index-creation -- watchers is a bounded configuration table; dbmate wraps this migration in a transaction, where CONCURRENTLY is not permitted
CREATE INDEX IF NOT EXISTS watchers_agent_recent
  ON public.watchers (organization_id, agent_id, last_run_completed_at DESC)
  WHERE status = 'active' AND last_run_completed_at IS NOT NULL;

-- One-time backfill. This is the aggregation the read path is losing —
-- appropriate once during migration and forbidden on a request path. Without it
-- every Behavior would be missing from the sidebar until its next completed run.
--
-- Reads `runs`, NOT `agent_transcript_snapshot`: grouping on a real FK lets this
-- use `idx_runs_watcher_id (watcher_id) WHERE watcher_id IS NOT NULL`, where
-- parsing conversation ids out of transcript history would force the same
-- unindexable scan this change exists to delete.
UPDATE public.watchers w
SET last_run_completed_at = GREATEST(
      COALESCE(w.last_run_completed_at, mx.last_at),
      mx.last_at
    )
FROM (
  SELECT watcher_id, max(completed_at) AS last_at
  FROM public.runs
  WHERE run_type = 'behavior'
    AND status = 'completed'
    AND watcher_id IS NOT NULL
    AND completed_at IS NOT NULL
  GROUP BY watcher_id
) mx
WHERE w.id = mx.watcher_id
  AND (
    w.last_run_completed_at IS NULL
    OR w.last_run_completed_at < mx.last_at
  );

-- migrate:down

DROP TRIGGER IF EXISTS stamp_watcher_last_run_completed_at ON public.runs;
DROP FUNCTION IF EXISTS public.stamp_watcher_last_run_completed_at();

-- squawk-ignore require-concurrent-index-deletion -- dbmate wraps this migration in a transaction, where CONCURRENTLY is not permitted
DROP INDEX IF EXISTS public.watchers_agent_recent;

-- squawk-ignore ban-drop-column -- rollback path for the column introduced by this migration
ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS last_run_completed_at;
