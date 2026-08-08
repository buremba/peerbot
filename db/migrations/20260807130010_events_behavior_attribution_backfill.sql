-- Which Behavior produced this event (part 2: backfill + validate).
--
-- Split from 20260807130000 because that migration's ADD COLUMN holds ACCESS
-- EXCLUSIVE on `events` until it commits; here the heaviest lock is ROW
-- EXCLUSIVE, so the 2.84M-row scan blocks nothing.
--
-- Casts use `^[0-9]{1,9}$`, not `^[0-9]+$`: the column is `integer`, and a
-- 10-digit value parses as numeric but overflows int4. The FKs are still NOT
-- VALID here, which exempts pre-existing rows but checks every row this
-- migration writes — so an unguarded id would abort the whole backfill.

-- migrate:up

-- Authoritative pass: the run row carries both the Behavior and the version it
-- executed. `runs.watcher_id` is itself FK'd, so it needs no guard; `version_id`
-- is free-form JSON text, so it gets a shape guard and an existence check — a
-- version deleted since the run would otherwise dangle and fail the FK.
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

-- Metadata pass: rows written outside a run row (direct `complete_window`, the
-- canvas and change-set writers). The join to `watchers` doubles as the
-- existence check — a dangling or cross-org id matches nothing and is skipped.
--
-- `metadata.watcher_id` means "ABOUT Behavior N", not "produced by Behavior N".
-- Several writers stamp it on HUMAN actions and every one is excluded below
-- (`correction` events, canvas corrections, the archive audit, and approval
-- cards); the behavior-produced writers are automation.ts and complete-window.
-- Getting this wrong is not cosmetic: `behavior_id` drives the window
-- self-exclusion, so claiming a human correction would make the Behavior stop
-- being shown the feedback written to correct it.
--
-- The approval guard keys on `interaction_type`, NOT on `metadata.tool`, and
-- that distinction is load-bearing. Measured on prod 2026-08-08, the rows this
-- pass would otherwise wrongly claim are:
--
--   tool               semantic_type  interaction_type  rows
--   manage_watchers    operation      approval             3
--   entity_field_change operation     approval            12
--
-- against 384 genuine output rows (social_signal 196, observation 90,
-- canvas_state 63, note 29, decision 5, summary 1) that all carry NO
-- `metadata.tool` at all. Two separate writers, and the first stamps the
-- LEGACY tool name — so a `tool <> 'manage_behaviors'` guard would have matched
-- nothing on prod while looking correct in review. `interaction_type` splits
-- the two sets exactly and survives the next rename.
UPDATE public.events e
SET behavior_id = w.id
FROM public.watchers w
WHERE e.behavior_id IS NULL
  AND e.semantic_type <> 'correction'
  -- Text comparison, not `::boolean` — that cast aborts the whole backfill on
  -- any non-boolean string a writer might leave there.
  AND COALESCE(e.metadata->>'correction', '') NOT IN ('true', 't', '1')
  AND COALESCE(e.metadata->>'action', '') <> 'watcher_archived'
  -- An approval card is a request made OF a human about the Behavior, never
  -- something the Behavior produced.
  AND COALESCE(e.interaction_type, '') <> 'approval'
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

-- Nothing to undo: 20260807130000's down drops the columns outright.
SELECT 1;
