-- Allow `run_type = 'behavior_eval'` (evals PR 2, lobu#2564).
--
-- An eval run replays a real Behavior window to score it. It reuses the `runs`
-- table rather than taking a column or a table of its own, which is what makes
-- it invisible to the ~18 existing `run_type = 'behavior'` predicates in the
-- scheduler, the reapers, and behavior-health: evals are excluded from all of
-- them for free, and only the execution path opts back in.
--
-- Side effects are not executed for this run type — the server derives
-- `executionMode = 'capture'` from it at session creation
-- (gateway/permissions/behavior-run-intent.ts) and carries it as a signed
-- worker-token claim. See packages/server/src/runs/run-types.ts.
--
-- EXPAND-only: widening a CHECK never invalidates an existing row, and NOT
-- VALID + VALIDATE keeps the table-scan off the exclusive-lock window (same
-- shape as 20260720140000). The list is that migration's FINAL contract step
-- (its up drops 'watcher' after the backfill) plus 'behavior_eval' — the
-- retired 'watcher' value must NOT be re-legalized here.

-- migrate:up
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'behavior'::text, 'behavior_eval'::text,
      'auth'::text, 'chat_message'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_run_type_check;

-- migrate:down
-- Eval replays are derived, disposable rows — without this the VALIDATE below
-- fails on any behavior_eval row and the down cannot run.
DELETE FROM public.runs WHERE run_type = 'behavior_eval';

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
