-- migrate:up

-- Revert the speculative `runs.agent_id` + `runs.conversation_id`
-- denormalization landed in PR #870 (migration
-- `20260518050000_runs_denormalize_agent_conversation.sql`).
--
-- The columns had zero consumers — `isRunOwnedByJwtScope` always
-- COALESCE-fell back to `action_input->>'key'`, the runs-queue claim
-- loop doesn't filter on them, and the reaper doesn't either. The
-- original perf justification ("JSONB full-scan in the verifier") was
-- wrong: the verifier query is a PK lookup (`WHERE id = $1`) and the
-- JSONB extraction on the single matched row is microseconds.
--
-- DROP COLUMN is metadata-only on PG11+ (brief AccessExclusive, no
-- table rewrite).

SET lock_timeout = '30s';

ALTER TABLE public.runs
    DROP COLUMN IF EXISTS conversation_id,
    DROP COLUMN IF EXISTS agent_id;

-- migrate:down

SET lock_timeout = '30s';

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS agent_id text,
    ADD COLUMN IF NOT EXISTS conversation_id text;
