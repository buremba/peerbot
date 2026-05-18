-- migrate:up

-- Per-run snapshot of OpenClaw's session.jsonl. Replaces the workspaces PVC
-- as the source of truth for conversation continuity across pod boundaries.
-- Today the helm chart pins `replicaCount: 1` because two pods can't mount
-- the RWO volume the session lives on; this table is the prerequisite for
-- flipping that. (PVC drop + chart change are Phase 5, separate PR.)
--
-- Schema choice notes:
-- - One row per (org, agent, conversation, run). The producer is
--   pi-coding-agent's `SessionManager`, whose internal entry taxonomy
--   evolves between library versions; we store the JSONL verbatim and
--   replay it byte-for-byte on the next worker boot.
-- - `terminal_status` discriminates success/failure paths so the next worker
--   doesn't hydrate from a snapshot that ended in a dangling tool_use trace.
--   Hydrate filters `WHERE terminal_status = 'completed'` and falls through
--   to older completed snapshots if the latest run failed.
-- - `byte_size` is `bytea_length(snapshot_jsonl::bytea)` — kept as a column
--   so the dashboard can plot growth without an expensive `length()` scan.
-- - No spill to R2: codex measured 633 KB max across 2050 production rows,
--   well inside Postgres TOAST's comfortable range. Optimisation deferred
--   until production data argues for it.

CREATE TABLE public.agent_transcript_snapshot (
    id              bigserial PRIMARY KEY,
    organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
    agent_id        text NOT NULL,
    conversation_id text NOT NULL,
    run_id          bigint NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
    snapshot_jsonl  text NOT NULL,
    byte_size       integer NOT NULL,
    terminal_status text NOT NULL,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT agent_transcript_snapshot_terminal_status_check
      CHECK (terminal_status IN ('completed', 'failed', 'timeout', 'cancelled')),
    UNIQUE (organization_id, agent_id, conversation_id, run_id)
);

-- Hydrate path is
--   SELECT snapshot_jsonl FROM agent_transcript_snapshot
--    WHERE organization_id = $1 AND agent_id = $2 AND conversation_id = $3
--      AND terminal_status = 'completed'
--    ORDER BY run_id DESC LIMIT 1
-- — a descending index on (org, agent, conv, run_id) serves the scan as a
-- single index-only seek. Partial-index on `terminal_status='completed'`
-- isn't worth it (we still want admin tooling to be able to inspect failed
-- snapshots without an index-not-applicable plan).
CREATE INDEX agent_transcript_snapshot_latest
    ON public.agent_transcript_snapshot
    (organization_id, agent_id, conversation_id, run_id DESC);

-- migrate:down

DROP TABLE IF EXISTS public.agent_transcript_snapshot;
