-- migrate:up

-- Finish the arrival-axis cutover by removing `completed_window_coverage`.
--
-- 20260903160000 moved Automation windowing onto the arrival mark and left this
-- column behind as a multirange holding exactly one contiguous range,
-- [first booked instant, next_window_start). Its own COMMENT said it "carries no
-- information the mark does not" and was "kept as a multirange for one release".
-- This is that release.
--
-- Structural evidence it is dead, checked against origin/main:
--   * Nothing reads it. The single `lower(completed_window_coverage)` in
--     `advanceAutomationArrivalMark` is self-referential — the column is read
--     only to preserve its own lower bound on the next write.
--   * The three other production references are INSERT column lists writing the
--     `'{}'` default (manage_automations/crud.ts create + clone,
--     gateway/channels/automation-subscription-service.ts).
--   * It is absent from every contract, client type, connector-SDK type and
--     Owletto surface, so no consumer can observe the drop.
--   * The value a caller actually consumes is `last_completed_window_start`,
--     which `get_content/automation-mode.ts` reads for the `window_lag` surface
--     and which this migration leaves untouched.
ALTER TABLE automations DROP COLUMN IF EXISTS completed_window_coverage;

-- migrate:down

-- Restores the column and its default. The historical ranges are NOT rebuilt:
-- they were derived from the mark, nothing consumed them, and the arrival mark
-- plus `last_completed_window_start` still carry every value a reader used.
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS completed_window_coverage tstzmultirange NOT NULL DEFAULT '{}'::tstzmultirange;
