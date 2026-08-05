-- migrate:up transaction:false

-- Behaviors (watchers) are org-level goals whose executor can be a managed
-- agent OR a device pin (device_worker_id), and manual-only Behaviors have no
-- automated triggers at all — their runs stay pending for any connected MCP
-- client to execute and complete. All three shapes are valid, so agent_id is
-- no longer mandatory.
--
-- The scheduler/event SELECTs already gate on
-- "device_worker_id IS NOT NULL OR (agent_id IS NOT NULL AND …)", so a null
-- agent with a device pin still fires; a null agent with no device pin is a
-- manual-only Behavior. The validation matrix (assertBehaviorExecutorsResolve)
-- enforces these shapes at write time.
--
-- LOCK SAFETY: ALTER COLUMN … DROP NOT NULL on a nullable-backed column is a
-- `relcache` catalog-only change with no table rewrite and no ACCESS EXCLUSIVE
-- scan, so it is safe to run in one statement (hence `transaction:false` —
-- there is no second statement to group with).
--
-- squawk-ignore ban-drop-not-null -- agentless rows are the point of this
-- migration: manual-only and device-pinned Behaviors carry no agent_id, and the
-- executor matrix (assertBehaviorExecutorsResolve) rejects automated
-- agentless rows at write time, so clients only ever read a null here for
-- shapes the app now explicitly allows.
ALTER TABLE public.watchers
  ALTER COLUMN agent_id DROP NOT NULL;

-- migrate:down

-- Reversing SET NOT NULL would fail if any agentless row now exists; only an
-- operator who has already removed/purged such rows may roll back.
ALTER TABLE public.watchers
  ALTER COLUMN agent_id SET NOT NULL;