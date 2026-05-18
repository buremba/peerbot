-- migrate:up

-- Denormalize agent_id + conversation_id out of `runs.action_input` JSONB
-- into real columns. Going forward `RunsQueue.send` populates these
-- columns on insert; `isRunOwnedByJwtScope` reads them with a
-- `COALESCE(scalar_column, action_input->>'key')` fallback so historical
-- rows (which still have NULL in the new columns) keep authorizing
-- correctly.
--
-- Deliberately NO backfill in this migration:
--   * The hot verifier path uses `runs_pkey` on `id` regardless of which
--     columns the routing keys live in; the JSONB extraction on the
--     single PK-matched row is microseconds.
--   * A single migrate-time backfill over a multi-million-row hot queue
--     table either holds row locks for the full duration (one big
--     UPDATE) or scans-with-LIMIT-cursor without an index to anchor it
--     (degenerates to O(N²) work). Neither is production-safe.
--   * Operators who want the columns populated for diagnostic queries
--     can run the chunked-with-keyset backfill from
--     `docs/runbooks/runs-backfill-denormalize.md` after the rollout.
--
-- ADD COLUMN with no DEFAULT and a nullable type is metadata-only on
-- PG11+: brief AccessExclusive, no table rewrite.

SET lock_timeout = '30s';

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS agent_id text,
    ADD COLUMN IF NOT EXISTS conversation_id text;

-- migrate:down

SET lock_timeout = '30s';
ALTER TABLE public.runs
    DROP COLUMN IF EXISTS conversation_id,
    DROP COLUMN IF EXISTS agent_id;
