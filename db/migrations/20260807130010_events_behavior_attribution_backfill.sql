-- Which Behavior produced this event (part 2: backfill + validate).
--
-- Companion to 20260807130000, split out because that migration's ADD COLUMN
-- holds ACCESS EXCLUSIVE on `events` until it commits. Here the heaviest lock
-- is ROW EXCLUSIVE (the UPDATEs) and SHARE UPDATE EXCLUSIVE (the VALIDATEs);
-- reads and writes proceed throughout.
--
-- The metadata pass needs one sequential scan of `events` (2.84M rows on prod,
-- ~945 matches measured 2026-08-07) — the one-time cost this column exists so
-- that no request ever pays it.
--
-- Every cast below is guarded. The FKs added in 20260807130000 are NOT VALID,
-- which exempts pre-existing rows but still checks every row THIS migration
-- writes, so an unguarded id would abort the whole backfill. `^[0-9]{1,9}$`
-- rather than `^[0-9]+$`: the column is `integer`, and a 10-digit value parses
-- as numeric but overflows int4.

-- migrate:up

-- Authoritative pass: the run row carries both the Behavior and the version it
-- executed (`approved_input->>'version_id'` is present on 100% of the 5,672
-- behavior runs in the last 90 days, measured 2026-08-07). `runs.watcher_id` is
-- itself FK'd to `watchers`, so it needs no guard; `version_id` is free-form
-- JSON text, so it gets both a shape guard and an existence check. Runs older
-- than the measured window can carry any shape, and a version deleted since the
-- run would dangle — either would fail the FK mid-backfill.
UPDATE public.events e
SET behavior_id = r.watcher_id,
    behavior_version_id = (
      SELECT wv.id
      FROM public.watcher_versions wv
      WHERE wv.id = CASE
        WHEN r.approved_input->>'version_id' ~ '^[0-9]{1,9}$'
          THEN (r.approved_input->>'version_id')::integer
      END
    )
FROM public.runs r
WHERE r.id = e.run_id
  AND r.watcher_id IS NOT NULL
  AND e.behavior_id IS NULL;

-- Metadata pass: rows written outside a run row (direct `complete_window`, and
-- the canvas/change-set writers, which key on `watcher_id`). The join to
-- `watchers` is the existence check — a dangling or cross-org id matches no row
-- and is skipped rather than failing the migration.
--
-- `metadata.watcher_id` means "this row is ABOUT Behavior N", which is not the
-- same as "Behavior N produced it". Three of the writers that stamp the key are
-- human actions, and all three are excluded below. Enumerated by grepping every
-- event writer that stamps the key, not by fixing the two that were noticed:
--
--   HUMAN, excluded:
--     * manage_operations.ts       semantic_type = 'correction'   (run rejected)
--     * manage_behaviors/feedback  canvas_state + metadata.correction = true
--     * manage_behaviors/crud      metadata.action = 'watcher_archived'
--   BEHAVIOR-PRODUCED, claimed:
--     * watchers/automation.ts     canvas_state (canvas-skip revision)
--     * persist-behavior-event-output / complete-window (outputs, change sets)
--
-- Getting this wrong is not cosmetic. `behavior_id` drives the window
-- self-exclusion, so mis-stamping a human correction would make the Behavior
-- stop being shown the feedback written to correct it — the one thing about its
-- own history it must keep reading.
--
-- None of the three exclusions removes a row today: on prod every candidate is
-- social_signal/observation/canvas_state/note/decision/summary with no
-- `correction` or `action` marker (measured 2026-08-07). They are here so the
-- first such row lands on the right side of the line. The WRITE paths are
-- already correct — none of the three passes `behaviorId` to insertEvent.
UPDATE public.events e
SET behavior_id = w.id
FROM public.watchers w
WHERE e.behavior_id IS NULL
  AND e.semantic_type <> 'correction'
  -- Text comparison, not `::boolean` — the cast aborts the whole backfill on
  -- any non-boolean string a writer might put there, and this guard must never
  -- be the thing that fails the migration.
  AND COALESCE(e.metadata->>'correction', '') NOT IN ('true', 't', '1')
  AND COALESCE(e.metadata->>'action', '') <> 'watcher_archived'
  AND e.organization_id = w.organization_id
  AND COALESCE(e.metadata->>'behavior_id', e.metadata->>'watcher_id') ~ '^[0-9]{1,9}$'
  AND COALESCE(e.metadata->>'behavior_id', e.metadata->>'watcher_id')::integer = w.id;

-- Rerunnable: VALIDATE on an already-valid constraint is a no-op. squawk cannot
-- see that (or the dbmate-managed transaction), hence the ignores.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.events VALIDATE CONSTRAINT events_behavior_id_fkey;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.events VALIDATE CONSTRAINT events_behavior_version_id_fkey;

-- migrate:down

-- Nothing to undo: the backfill only populates columns that 20260807130000's
-- down migration drops outright, and validation is catalog state on the
-- constraints it drops with them.
SELECT 1;
