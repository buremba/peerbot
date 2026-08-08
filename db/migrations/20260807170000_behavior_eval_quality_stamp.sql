-- migrate:up

-- Write-time quality stamp for a Behavior (evals PR 4, lobu#2564).
--
-- Scores live as append-only `eval_score` events, and history only grows — so
-- any surface showing "how good is this Behavior" must NEVER aggregate them at
-- read time. These three columns are the materialized answer, written by the
-- scorer when it finishes a run so that a reader gets it from the `watchers`
-- row it already selects. Same shape as `watchers.last_run_completed_at`
-- (20260730210000).
--
-- Written here, read by a later PR: this PR ships the scorer, not the listing
-- column that renders it.
--
-- `latest_eval_score` is the pass FRACTION over the metrics that actually
-- produced a verdict on that run (0.0–1.0), not a count: metrics come and go
-- (the judge is skipped when no provider resolves), so a raw count would not be
-- comparable across runs while a fraction is.
--
-- Nullable with no default and no backfill: NULL means "never scored", which is
-- the truth for every Behavior until its first eval run is scored. A 0 default
-- would be indistinguishable from "scored, failed everything".
ALTER TABLE public.watchers
  ADD COLUMN IF NOT EXISTS latest_eval_score numeric(4, 3),
  ADD COLUMN IF NOT EXISTS latest_eval_at timestamptz,
  ADD COLUMN IF NOT EXISTS latest_eval_run_id bigint;

COMMENT ON COLUMN watchers.latest_eval_score IS
  'Pass fraction (0.000-1.000) of the most recently scored eval run. Materialized by the scorer; never aggregated at read time. NULL = never scored.';
COMMENT ON COLUMN watchers.latest_eval_at IS
  'When latest_eval_score was stamped.';
COMMENT ON COLUMN watchers.latest_eval_run_id IS
  'The behavior_eval run that produced latest_eval_score. Deliberately no FK: runs are prunable and a pruned run must not block or rewrite the stamp.';

-- migrate:down

ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS latest_eval_score,
  DROP COLUMN IF EXISTS latest_eval_at,
  DROP COLUMN IF EXISTS latest_eval_run_id;
