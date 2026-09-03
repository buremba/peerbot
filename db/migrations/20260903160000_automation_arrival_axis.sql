-- migrate:up

-- Automation windowing moves from `occurred_at` calendar periods to a single
-- arrival mark on `events.created_at`.
--
-- Why: a calendar window closes on the day content is dated, not on the day
-- Lobu stored it. In production 56.3% of first-seen connector rows were stored
-- more than an hour after their `occurred_at`, and 37.8% more than seven days
-- after (backfill-shaped: the X archive's median row is 6.4 years old, and a
-- `chrome.history` rescan re-delivers a 26-day span). Every one of those rows
-- lands behind a window that has already completed, so no run ever sees it.
-- The arrival axis is the only axis on which "everything since the last run"
-- is lossless without a per-event processed-ledger.
--
-- The new state is one scalar: `automations.next_window_start` is the mark, and
-- a run covers `[mark, now() - 60s)`. Claims serialize per Automation, so the
-- mark and the coverage range can never diverge.

-- 1. Drop the two run-row triggers that re-derive calendar coverage.
--
-- These are not merely redundant on the new axis, they are actively wrong: both
-- recompute `next_window_start` and `completed_window_coverage` from a run's
-- schedule granularity, which would drag the mark back onto period boundaries
-- after every completion. The application is now the single writer of the mark
-- (`advanceAutomationArrivalMark` in `packages/server/src/utils/window-utils.ts`),
-- called inside the same transaction as the completion it books.
--
-- Safe as an app-only writer: the only completion paths that store
-- `action_output` — and so the only ones these triggers ever fired for — are
-- `complete-window.ts` and `completeSkippedAutomationRun` in
-- `automations/automation.ts`. `run-completion.ts`, `runs-queue.ts` and the
-- device exit report in `run-lifecycle.ts` never set it.
DROP TRIGGER IF EXISTS advance_automation_window_projection_from_run ON public.runs;
DROP FUNCTION IF EXISTS public.advance_automation_window_projection_from_run();

DROP TRIGGER IF EXISTS record_automation_last_completed_window_from_run ON public.runs;
DROP FUNCTION IF EXISTS public.record_automation_last_completed_window_from_run();

-- 2. Seed every Automation's mark to the cutover instant.
--
-- An honest fast-forward, not a backfill. The old coverage is expressed in
-- `occurred_at` and cannot be translated onto the arrival axis — there is no
-- record of which rows a calendar window actually read. Starting every
-- Automation from "now" means each one's first arrival run covers what has
-- landed since this migration, and nothing claims to have processed what it
-- did not. Rows stored before the cutover stay unclaimed by design; an agent
-- that wants them asks for an explicit `since`/`until` range.
--
-- The instant comes from the database clock, the same clock that stamps
-- `events.created_at`, and is truncated to milliseconds so the value
-- round-trips through a run's `approved_input` unchanged.
UPDATE automations
SET next_window_start = date_trunc('milliseconds', current_timestamp),
    completed_window_coverage = '{}'::tstzmultirange,
    last_completed_window_start = NULL,
    window_projection_granularity = NULL;

-- 3. Retell the columns on the new axis.
--
-- `window_projection_granularity` keeps its NULL values and no longer has a
-- writer; the follow-up that retypes `completed_window_coverage` to a plain
-- timestamptz drops it.
COMMENT ON COLUMN automations.next_window_start IS
  'Arrival mark: the oldest events.created_at not yet covered by a completed run. Advanced only by advanceAutomationArrivalMark, inside the completion transaction.';
COMMENT ON COLUMN automations.completed_window_coverage IS
  'Completed arrival coverage as one contiguous range [first booked, next_window_start). Kept as a multirange for one release; it carries no information the mark does not.';
COMMENT ON COLUMN automations.window_projection_granularity IS
  'Unused. Held the calendar granularity that interpreted the pre-arrival-axis window cursor; dropped once completed_window_coverage is retyped.';

-- migrate:down

-- Irreversible by design. The pre-cutover cursor was expressed in occurred_at
-- calendar periods and the arrival mark carries no granularity to rebuild them
-- from, so restoring the triggers would re-derive coverage that never existed.
-- Rolling back means restoring the two functions from
-- 20260822170000_automation_expected_window_cursor.sql and
-- 20260822230000_automation_last_completed_window.sql and re-running their
-- backfills against a server build that still writes a granularity.
SELECT 1;
