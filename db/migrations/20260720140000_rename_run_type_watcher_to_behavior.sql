-- migrate:up transaction:false

-- Rename the runs.run_type enum value 'watcher' -> 'behavior' so the run
-- execution layer matches the rest of the public surface (the SDK, REST,
-- MCP contracts, and channel bindings already say "behavior"; run_type was
-- the last place the internal "watcher" term leaked to callers via
-- manage_operations activity/list_runs). The `watchers` TABLE stays named
-- `watchers` (internal schedule-definition backing table, referenced by
-- behavior_id FKs); only the run_type VALUE changes.
--
-- OPERATIONAL COST: the backfill UPDATE below rewrites only rows with
-- run_type='watcher'. On prod that is the behavior-run history (tens of
-- thousands of rows at most, far below the events-table danger zone). It
-- takes regular row locks (not ACCESS EXCLUSIVE) and completes in well
-- under the statement_timeout. The CHECK swaps are O(1) metadata flips
-- (NOT VALID add + VALIDATE with SHARE UPDATE EXCLUSIVE). Index rebuilds are
-- CONCURRENTLY (no table lock). Not tested at prod size; behavior-run volume
-- is low enough that this is safe.
--
-- ROLLING-DEPLOY NOTE (accepted risk, single-PR hard cutover decided
-- 2026-07-20): the Helm pre-upgrade hook runs this BEFORE new pods roll. For
-- the ~30-90s RollingUpdate window, old pods still enqueue run_type='watcher'
-- (queue-service.createWatcherRun) and read WHERE run_type='watcher'. After
-- the contract step below the CHECK rejects 'watcher', so an old pod's
-- behavior-run enqueue fails during that window and old-pod reads find zero
-- behavior runs. We ACCEPT this: behavior runs are low-frequency (cron/interval
-- schedules + manual triggers), the scheduler retries on the next tick, and the
-- window is bounded by the rollout. If behavior-run volume ever grows, redo this
-- as expand/contract across two deploys (widen CHECK + dual-read this deploy,
-- contract next deploy).

-- Step 1 (EXPAND): widen the CHECK constraints to allow BOTH values so the
-- backfill and any in-flight 'watcher' write are legal mid-migration.
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'watcher'::text, 'behavior'::text, 'auth'::text, 'chat_message'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_run_type_check;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_legacy_org_required;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_legacy_org_required CHECK (
    (run_type <> ALL (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'watcher'::text, 'behavior'::text, 'auth'::text
    ])) OR (organization_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_legacy_org_required;

-- Step 2 (BACKFILL): rewrite existing behavior-run rows to the new value.
UPDATE public.runs SET run_type = 'behavior' WHERE run_type = 'watcher';

-- Step 3 (INDEXES): build behavior-predicate twins CONCURRENTLY, then drop the
-- old watcher-predicate ones. Each CONCURRENTLY statement is isolated (Postgres
-- rejects multiple CONCURRENTLY in one implicit batch).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_executing_per_behavior
  ON public.runs (watcher_id)
  WHERE run_type = 'behavior'
    AND watcher_id IS NOT NULL
    AND status IN ('claimed', 'running');

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_pending_non_event_per_behavior
  ON public.runs (watcher_id)
  WHERE run_type = 'behavior'
    AND watcher_id IS NOT NULL
    AND status = 'pending'
    AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event';

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_executing_watcher_per_watcher;

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_pending_non_event_watcher_per_watcher;

-- Step 4 (CONTRACT): drop 'watcher' from the CHECK constraints now that no row
-- and no new-pod write uses it. This is the step that makes an old pod's
-- 'watcher' enqueue fail during the rollout window (see note above).
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'behavior'::text, 'auth'::text, 'chat_message'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_run_type_check;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_legacy_org_required;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_legacy_org_required CHECK (
    (run_type <> ALL (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'behavior'::text, 'auth'::text
    ])) OR (organization_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_legacy_org_required;

-- migrate:down transaction:false

-- Reverse: allow both, backfill behavior -> watcher, restore watcher indexes,
-- contract back to 'watcher'-only.
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'watcher'::text, 'behavior'::text, 'auth'::text, 'chat_message'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_run_type_check;

UPDATE public.runs SET run_type = 'watcher' WHERE run_type = 'behavior';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_executing_watcher_per_watcher
  ON public.runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status IN ('claimed', 'running');

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_pending_non_event_watcher_per_watcher
  ON public.runs (watcher_id)
  WHERE run_type = 'watcher'
    AND watcher_id IS NOT NULL
    AND status = 'pending'
    AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event';

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_executing_per_behavior;

DROP INDEX CONCURRENTLY IF EXISTS idx_runs_pending_non_event_per_behavior;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'watcher'::text, 'auth'::text, 'chat_message'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_run_type_check;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_legacy_org_required;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_legacy_org_required CHECK (
    (run_type <> ALL (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'watcher'::text, 'auth'::text
    ])) OR (organization_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_legacy_org_required;
