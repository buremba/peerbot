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
-- `correction` is excluded deliberately. `submit_feedback` stamps
-- `metadata.watcher_id` on it, but a correction is authored by a HUMAN about
-- the Behavior — not something the Behavior produced. Stamping it would enrol
-- it in the self-exclusion this column drives, and the Behavior would stop
-- being shown the feedback written to correct it, which is the one thing about
-- its own history it must keep reading.
--
-- Nothing is skipped by this today: prod holds ZERO correction events
-- (measured 2026-08-07). The clause is here so the first one written lands on
-- the right side of the line, not to filter existing rows.
UPDATE public.events e
SET behavior_id = w.id
FROM public.watchers w
WHERE e.behavior_id IS NULL
  AND e.semantic_type <> 'correction'
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
