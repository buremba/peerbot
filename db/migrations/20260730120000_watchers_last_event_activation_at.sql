-- migrate:up

-- `min_cooldown_seconds` is the operator's debounce for event-triggered
-- Behaviors. It needs a cursor recording when a Behavior last *activated on an
-- event*, and none of the existing columns mean that:
--
--   * `last_fired_at` is stamped when a run reaches a TERMINAL state
--     (run-lifecycle completion/failure). A burst that starts a run and
--     immediately re-fires would not be debounced by the run it just started,
--     so the cooldown would only take effect after the first run happened to
--     finish.
--   * `runs.created_at` covers background Behaviors but not `reply_to_source`
--     ones — reply targets are routed through the chat transport and never
--     write a `behavior` run row, so the cooldown would be a silent no-op on
--     exactly the Behaviors an operator is most likely to want debounced.
--
-- One cursor, written by both activation paths under the existing
-- per-Behavior advisory lock, keeps a single predicate for a single feature.
-- Deliberately scoped to event activations: a schedule already spaces its own
-- firings (cron IS the operator's cadence control), and suppressing a
-- scheduled firing would strand `next_run_at` in the past and hot-loop.
--
-- Nullable with no backfill: an existing Behavior has no recorded event
-- activation, so its first activation after this deploy is allowed. That is
-- the correct reading of "has not fired within the cooldown window".
ALTER TABLE public.watchers
  ADD COLUMN IF NOT EXISTS last_event_activation_at timestamp with time zone;

-- migrate:down

ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS last_event_activation_at;
