-- migrate:up

-- WHO caused this run. Until now provenance was reassembled ad-hoc at each
-- writer from `ctx.actingWatcherId ?? args.behavior_source?.behavior_id`, which
-- only ever describes a behavior — so every run started by an MCP/agent session
-- landed as an orphan (watcher_id null, created_by_user_id null, no way back to
-- the session that asked for it). `initiator_kind` names the channel and
-- `initiator_ref` carries its identifiers, so one column pair covers every
-- caller instead of one nullable column per channel.
--
-- Kinds: 'user' | 'behavior' | 'agent_session' | 'schedule' | 'system'.
-- Deliberately a plain text column, not an enum: kinds are a product concept
-- that will grow, and an enum would need a migration per addition.
--
-- `watcher_id` / `window_id` stay — the scheduler and the approval-batching
-- queries filter on them. For behavior runs the two channels describe the same
-- thing and a test pins them consistent.
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS initiator_kind text,
  ADD COLUMN IF NOT EXISTS initiator_ref jsonb;

-- Existing rows keep NULL: there is no evidence to reconstruct their initiator
-- from, and inventing one would be worse than rendering "unknown origin".
-- Partial index — provenance lookups always filter to rows that have a kind.
CREATE INDEX IF NOT EXISTS idx_runs_initiator
  ON public.runs (organization_id, initiator_kind)
  WHERE initiator_kind IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS idx_runs_initiator;

-- squawk-ignore ban-drop-column
ALTER TABLE public.runs
  DROP COLUMN IF EXISTS initiator_kind,
  DROP COLUMN IF EXISTS initiator_ref;
