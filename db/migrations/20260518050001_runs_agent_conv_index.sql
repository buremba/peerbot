-- migrate:up transaction:false

-- Partial index on (agent_id, conversation_id, id DESC) for queries that
-- look up runs by the (agent, conversation) pair without specifying id
-- (diagnostics, history pruning, scheduled cleanup sweeps). The verifier
-- `isRunOwnedByJwtScope` does NOT need this index — `runs_pkey` already
-- serves its single-row lookup.
--
-- Built CONCURRENTLY in its own transaction:false migration so the index
-- build does not hold a write-blocking lock on the multi-million-row
-- runs table during a prod rollout. CONCURRENTLY requires the statement
-- to NOT be inside a transaction block; isolating it in its own file
-- with `transaction:false` is the only way to get dbmate's pq driver to
-- present this without an enclosing BEGIN/COMMIT. Codex round 3 P1#2 on
-- PR #870.

CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_agent_conv_idx
    ON public.runs (agent_id, conversation_id, id DESC)
    WHERE agent_id IS NOT NULL AND conversation_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.runs_agent_conv_idx;
