-- migrate:up transaction:false

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
--
-- LOCK SAFETY. This is deliberately NOT one transaction. `ALTER TABLE ... ADD
-- COLUMN` takes ACCESS EXCLUSIVE on `public.watchers` and Postgres holds that
-- lock until COMMIT, so bundling the one-time `runs` aggregation at the bottom
-- of this file into the same transaction would run that history-sized scan
-- *under* ACCESS EXCLUSIVE and stall every Behavior read and write for its
-- duration. Under transaction:false each statement commits standalone (the
-- runners split these sections statement-at-a-time; prod: scripts/migrate-up.mjs,
-- embedded/tests: packages/server/src/db/migration-loader.ts), so the column add
-- is a momentary catalog-only lock (nullable, no default — no table rewrite),
-- the index builds CONCURRENTLY, and the `runs` scan holds nothing stronger than
-- ROW EXCLUSIVE on the rows it stamps.
--
-- RETRY SAFETY. transaction:false can leave earlier statements committed with
-- this migration's ledger row unwritten, so every statement below is written to
-- re-run: the section converges on replay from any crash point.
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
--
-- The INVALID-carcass heal is inlined so it re-runs on every retry: a crashed
-- CONCURRENTLY build leaves a same-named INVALID index that `IF NOT EXISTS`
-- would silently no-op over, recording this migration as applied with a
-- non-enforcing carcass in place.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'watchers_agent_recent'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.watchers_agent_recent';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS watchers_agent_recent
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
--
-- Runs in its own transaction (see LOCK SAFETY above), so however long this scan
-- takes it never holds a lock on `watchers` beyond ROW EXCLUSIVE plus the rows it
-- stamps. It is placed after the trigger so a completion landing mid-scan is
-- stamped rather than lost, and the GREATEST/`<` guard makes a replay a no-op
-- once a later stamp is already in place.
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

-- migrate:down transaction:false

DROP TRIGGER IF EXISTS stamp_watcher_last_run_completed_at ON public.runs;
DROP FUNCTION IF EXISTS public.stamp_watcher_last_run_completed_at();

DROP INDEX CONCURRENTLY IF EXISTS public.watchers_agent_recent;

-- squawk-ignore ban-drop-column -- rollback path for the column introduced by this migration
ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS last_run_completed_at;
