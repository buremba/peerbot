-- Repair Behavior output that was stamped at its window END rather than at the
-- moment it was written.
--
-- 20260807130000..130020 stopped NEW rows getting a future stamp (the writer now
-- clamps to `min(window_end, now())`) and gave every produced row a `behavior_id`.
-- Neither repairs the rows already written. This does.
--
-- Measured on prod 2026-08-08, before this ran:
--
--   behavior-produced rows                     514
--   ...stamped ahead of their own created_at   431   (335 via runs, 96 via metadata)
--   ...still in the future, i.e. invisible      16
--   distinct orgs affected                       1
--   furthest ahead                          2 days
--
-- The signature is unmistakable in the data: a run that started 03:25 wrote rows
-- stamped 23:59 the same day — 20.6h ahead, exactly the daily window end. Every
-- affected row is a Behavior artifact (observation 156, canvas_state 98,
-- change_set 49, draft_reply 28, voice_profile 4). None of those semantic types
-- is ever legitimately future-dated.
--
-- WHY `behavior_id IS NOT NULL` AND NOT a bare `occurred_at > created_at`:
-- 35,740 rows repo-wide have `occurred_at > created_at` and the overwhelming
-- majority are CORRECT — 223 of the 249 rows currently in the future are
-- `calendar_event`, plus flights, birthdays and meetings carrying
-- `semantic_type = 'event'`. Those are genuinely future occurrences and must
-- keep their stamps. They have no Behavior run and no `metadata.watcher_id`, so
-- the backfill leaves `behavior_id` NULL and this UPDATE cannot reach them.
--
-- This is an UPDATE, not a DELETE: `events` stays append-only. It corrects a
-- column that was never meant to hold a window boundary; it does not retract a
-- row. Ordering of historical feeds changes for the affected rows, which is the
-- point — they currently sort ahead of events that really did happen later.
--
-- No unique index on `events` includes `occurred_at` (verified 2026-08-08), so
-- rewriting it cannot collide with a dedupe or chain-root constraint.

-- migrate:up

-- Bounded by the partial index `idx_events_behavior_produced`
-- (WHERE behavior_id IS NOT NULL) that 20260807130020 created, so this touches
-- ~500 rows rather than scanning 2.84M. Heaviest lock is ROW EXCLUSIVE.
--
-- Rerunnable: once a row is repaired `occurred_at = created_at`, so the strict
-- `>` no longer matches it.
UPDATE public.events
SET occurred_at = created_at
WHERE behavior_id IS NOT NULL
  AND occurred_at > created_at;

-- migrate:down

-- Irreversible by design. The original stamps were derived window boundaries,
-- not observations — there is nothing truthful to restore them to, and the
-- writer that produced them no longer exists.
SELECT 1;
