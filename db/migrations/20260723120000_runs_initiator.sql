-- migrate:up

-- Record the verified principal that requested a run. `initiator_kind` names
-- the principal channel and `initiator_ref` carries its identifiers.
--
-- Kinds: 'user' | 'behavior' | 'agent_session' | 'system'. Keep this as text so
-- adding a new principal channel does not require changing a database enum.
--
-- Existing watcher_id/window_id columns remain the operational keys used by
-- behavior scheduling and approval batching.
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS initiator_kind text,
  ADD COLUMN IF NOT EXISTS initiator_ref jsonb;

-- Existing rows remain NULL because their initiator cannot be reconstructed
-- reliably.

-- migrate:down

-- squawk-ignore ban-drop-column
ALTER TABLE public.runs
  DROP COLUMN IF EXISTS initiator_kind,
  DROP COLUMN IF EXISTS initiator_ref;
