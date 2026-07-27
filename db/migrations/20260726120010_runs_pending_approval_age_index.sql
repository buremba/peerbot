-- migrate:up transaction:false

-- Age index for the pending-approval expiry sweeper + the stale-pending health
-- metric. Both scan `runs` for approval_status='pending' ordered/filtered by
-- created_at across every org; without this the tick is a seq-scan of the whole
-- runs table. Partial on the pending predicate so the index stays tiny (pending
-- approvals are a handful of rows next to the full run history).
--
-- The INVALID-carcass heal is inlined (not a companion migration) so it re-runs
-- on every retry: if a CONCURRENTLY build crashes it leaves a same-named INVALID
-- index, and `IF NOT EXISTS` would silently no-op over it and record this
-- migration as applied with a non-enforcing carcass in place. The runners split
-- transaction:false sections statement-at-a-time (prod: scripts/migrate-up.mjs;
-- embedded/tests: packages/server/src/db/migration-loader.ts), so the heal DO
-- and the CONCURRENTLY build each run unwrapped.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_runs_pending_approval_created_at'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_runs_pending_approval_created_at';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_pending_approval_created_at
  ON public.runs (created_at)
  WHERE approval_status = 'pending';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_pending_approval_created_at;
