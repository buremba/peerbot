-- Outcome taxonomy for terminal runs (evals PR 1, lobu#2564).
--
-- A terminal run's `status` says HOW it ended (completed/failed/timeout); it
-- does not say WHOSE FAULT it was. The July-2026 z.ai quota storm read as a
-- 61-78% Behavior "prompt regression" because 2,200+ provider 429s and ~370
-- genuine agent protocol violations landed in the same `failed` bucket.
--
-- `outcome` classifies a terminal run at WRITE TIME (request paths never
-- aggregate history):
--   infra_error  - provider/platform/config fault; the run is not evidence
--                  about the agent (quota, auth, worker death, dispatch
--                  failure, timeout).
--   agent_error  - the agent ran and misbehaved (finalize miss, CLI crash);
--                  quality-relevant.
--   scoreable    - completed cleanly; judgeable by the eval layer.
-- NULL          - non-terminal, cancelled, a non-behavior completed/failed
--                 run (their writers don't stamp: agent_error/scoreable are
--                 agent-run concepts — eval reads filter run_type='behavior'),
--                 or predating the backfill
--                 (scripts/backfill-run-outcomes.ts fills history by calling
--                 the real classifier, never a SQL mirror of it).
--
-- Single classifier: packages/server/src/runs/run-outcome.ts.

-- migrate:up
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS outcome text
  CONSTRAINT runs_outcome_check
  CHECK (outcome = ANY (ARRAY['infra_error'::text, 'agent_error'::text, 'scoreable'::text]));

-- migrate:down
ALTER TABLE public.runs DROP COLUMN IF EXISTS outcome;
