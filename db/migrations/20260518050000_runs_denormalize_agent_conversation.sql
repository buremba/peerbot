-- migrate:up transaction:false

-- Denormalize agent_id + conversation_id out of `runs.action_input` JSONB into
-- real columns. The original verifier (`isRunOwnedByJwtScope`) queried
-- `WHERE id=$1 AND organization_id=$2 AND action_input->>'agentId'=$3 AND
-- action_input->>'conversationId'=$4`; the PK on `id` already short-circuits
-- to a single row, so the bottleneck wasn't a seq scan — it was the JSONB
-- extraction on every snapshot POST plus the absence of a clean shape for
-- *other* queries that want "all runs for this (agent, conversation)" (e.g.
-- diagnostics, deletion sweeps). Real, scalar columns are the right
-- long-term shape; the index below earns its keep on those queries, not on
-- the verifier.
--
-- transaction:false (per
-- 20260426130001_db_integrity_cleanup_concurrent.sql) so:
--   - ALTER TABLE commits immediately and releases its AccessExclusive lock.
--   - The chunked backfill runs as many small transactions instead of one
--     unbounded UPDATE that would hold row locks for the duration on a
--     million-row table.
--   - CREATE INDEX commits independently. (CONCURRENTLY would be even
--     better but dbmate + pq presents it as in-transaction, code 25001,
--     so we use plain CREATE INDEX. On the multi-million-row runs table
--     this holds a SHARE lock — concurrent reads OK, writes briefly
--     blocked — for the duration of the build.)
--
-- Statements are idempotent: re-running after a partial failure converges
-- to the desired state.

SET lock_timeout = '30s';

-- Step 1: add the columns. ADD COLUMN with no DEFAULT and a nullable type
-- is metadata-only on PG11+: brief AccessExclusive, no table rewrite.
ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS agent_id text,
    ADD COLUMN IF NOT EXISTS conversation_id text;

-- Step 2: chunked backfill historical rows from action_input. A single
-- unbounded UPDATE over millions of rows would (a) hold many row locks at
-- once, (b) bloat the WAL with one massive transaction, and (c) fight live
-- INSERTs for tuple locks for the entire duration.
--
-- PG11+ stored procedures (CREATE PROCEDURE) support `COMMIT` inside the
-- loop body — a DO block does NOT (it runs as a single implicit
-- transaction). We create the procedure, CALL it, then drop it. Codex
-- round 2 P1#1 on PR #870 — the previous DO-block version did not actually
-- chunk-commit.
--
-- The `agent_id IS NULL` guard makes the backfill safe to interrupt and
-- resume: a re-CALL picks up only rows still NULL.
--
-- Tunable: bump the chunk size (default 5000) by setting the GUC
-- `lobu.backfill_chunk` before the migration runs. Keep <= 50k to avoid
-- long single-statement UPDATEs holding too many row locks per commit.
SET lock_timeout = 0;

CREATE OR REPLACE PROCEDURE pg_temp.lobu_backfill_runs_agent_conv()
LANGUAGE plpgsql
AS $proc$
DECLARE
    chunk_size int := COALESCE(
        NULLIF(current_setting('lobu.backfill_chunk', true), '')::int,
        5000
    );
    rows_updated int;
BEGIN
    LOOP
        UPDATE public.runs
           SET agent_id = action_input->>'agentId',
               conversation_id = action_input->>'conversationId'
         WHERE id IN (
             SELECT id FROM public.runs
              WHERE agent_id IS NULL
                AND action_input ? 'agentId'
              LIMIT chunk_size
         );
        GET DIAGNOSTICS rows_updated = ROW_COUNT;
        EXIT WHEN rows_updated = 0;
        -- COMMIT releases the row locks taken by this chunk's UPDATE and
        -- starts a fresh transaction for the next chunk. Only legal
        -- inside a PROCEDURE (not a DO block) and only when the procedure
        -- was invoked at the top level (which CALL does under
        -- transaction:false).
        COMMIT;
    END LOOP;
END
$proc$;

CALL pg_temp.lobu_backfill_runs_agent_conv();

SET lock_timeout = '30s';

-- Step 3: index on (agent_id, conversation_id) for queries that look up
-- runs by the (agent, conversation) pair without specifying id (e.g.
-- diagnostics, history pruning, scheduled cleanup sweeps). The verifier
-- `isRunOwnedByJwtScope` does NOT need this index — `runs_pkey` on `id`
-- already serves its single-row lookup. The win there is removing the
-- JSONB extraction operator from the predicate and lifting the routing
-- keys into typed columns.
CREATE INDEX IF NOT EXISTS runs_agent_conv_idx
    ON public.runs (agent_id, conversation_id, id DESC)
    WHERE agent_id IS NOT NULL AND conversation_id IS NOT NULL;

-- migrate:down transaction:false

SET lock_timeout = '30s';
DROP INDEX IF EXISTS public.runs_agent_conv_idx;
ALTER TABLE public.runs
    DROP COLUMN IF EXISTS conversation_id,
    DROP COLUMN IF EXISTS agent_id;
