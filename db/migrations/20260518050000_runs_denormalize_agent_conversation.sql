-- migrate:up

-- Denormalize agent_id + conversation_id out of `runs.action_input` JSONB into
-- real columns. The hot path `isRunOwnedByJwtScope` (every snapshot POST,
-- multiple times per chat turn under LOBU_SESSION_STORE=snapshot) currently
-- does `WHERE id=$1 AND organization_id=$2 AND action_input->>'agentId'=$3
-- AND action_input->>'conversationId'=$4`. With no functional or expression
-- index covering the JSONB shape, that's a seq scan; on a runs table with
-- millions of rows it's 10–100 ms per request, multiplied across every
-- worker completion.
--
-- After this migration the verifier reads the new scalar columns and a
-- partial covering index serves an index-only scan.
--
-- Schema choice notes:
-- - Columns are nullable: not every run_type carries an (agentId,
--   conversationId) — sync/action/auth/watcher runs leave them NULL.
-- - Partial index over the non-null subset keeps the index small (only
--   chat_message/agent_run/task lanes that actually carry these keys), and
--   the verifier path always queries for non-null values so the planner
--   will choose it.
-- - Migration intentionally NOT `transaction:false`: dbmate's transaction
--   handling against pq still presents CONCURRENTLY statements as
--   in-transaction to Postgres, so they fail with code 25001 ("cannot run
--   inside a transaction block") — see commentary on
--   `20260426130001_db_integrity_cleanup_concurrent.sql` for the precedent.
--   Building this index non-concurrently holds ACCESS EXCLUSIVE on `runs`
--   for the duration of the build. On prod's largest table the build is
--   a few seconds at worst and runs at deploy time. Worker queues retry on
--   the brief block.

-- Set a defensive lock_timeout so any unexpected contention surfaces as a
-- fast failure rather than a stuck deploy.
SET lock_timeout = '30s';

-- Step 1: add the columns. ADD COLUMN with no DEFAULT and a nullable type is
-- metadata-only on PG11+: brief ACCESS EXCLUSIVE, no table rewrite.
ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS agent_id text,
    ADD COLUMN IF NOT EXISTS conversation_id text;

-- Step 2: backfill historical rows from action_input. The WHERE clause filters
-- to rows where the JSONB carries the keys at the top level, mirroring the
-- shape MessagePayload writes today (see queue-producer.ts). Setting both
-- columns in one UPDATE avoids a second pass.
--
-- Safe to re-run: rows that already have the columns populated by the
-- application code (new inserts after this migration ships) are excluded by
-- the `agent_id IS NULL` guard.
--
-- Bump lock_timeout to 0 for the UPDATE — row locks held briefly during a
-- backfill on a busy table can legitimately wait more than 30s on prod, and
-- the row-level locking is cooperative with concurrent INSERTs.
SET lock_timeout = 0;
UPDATE public.runs
   SET agent_id = action_input->>'agentId',
       conversation_id = action_input->>'conversationId'
 WHERE agent_id IS NULL
   AND action_input ? 'agentId';

SET lock_timeout = '30s';

-- Step 3: partial covering index for the isRunOwnedByJwtScope hot path.
-- The verifier query is
--   SELECT 1 FROM runs
--    WHERE id = $1 AND organization_id = $2
--      AND agent_id = $3 AND conversation_id = $4 LIMIT 1
-- which the planner resolves via an index-only scan on this index.
-- Lead with `id` because id alone is highly selective (PK); the trailing
-- columns are used for equality checks under that single row to enforce
-- the JWT scope.
CREATE INDEX IF NOT EXISTS runs_agent_conv_idx
    ON public.runs (id, organization_id, agent_id, conversation_id)
    WHERE agent_id IS NOT NULL AND conversation_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.runs_agent_conv_idx;
ALTER TABLE public.runs
    DROP COLUMN IF EXISTS conversation_id,
    DROP COLUMN IF EXISTS agent_id;
