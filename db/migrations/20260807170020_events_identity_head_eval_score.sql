-- migrate:up transaction:false

-- Head-probe index for eval scores (evals PR 4, lobu#2564).
--
-- Companion to 20260807170010, and required for the same reason that pairing
-- exists for `behavior_event` (20260806120010 root + 20260806120020 head): the
-- root index is the CONSTRAINT and cannot also serve the head PROBE.
--
-- `writeScoreEvent` looks up the live head before superseding it — `WHERE
-- organization_id = $1 AND identity_ns = 'eval_score' AND identity_key = $2 AND
-- superseded_by IS NULL`. A partial index is usable only when the query implies
-- its predicate, and `superseded_by IS NULL` does not imply the root index's
-- `supersedes_event_id IS NULL` (a chain's head is usually NOT its root). So
-- without this index the planner falls back to idx_events_live_org_created and
-- filters the org's whole live set on every probe — the O(org history) shape
-- measured at 970 ms at prod scale, and worst on the common no-head first-score
-- path, which scans everything before concluding nothing matches. The scorer
-- runs this probe once per metric per run, so it is the hot path here.
--
-- Non-unique, exactly as the behavior_event probe index is: insertEvent inserts
-- the successor before stamping the predecessor's superseded_by, so both rows
-- are briefly live inside that transaction and a UNIQUE live-head index would
-- reject every ordinary supersede. The stamp removes the replaced row from this
-- index automatically.
--
-- CONCURRENTLY (transaction:false, ONE statement per migration): db:lint bans a
-- blocking build on the hot events table, and dbmate sends a transaction:false
-- block as a single simple-query batch that CONCURRENTLY cannot share.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_identity_head_eval_score
  ON public.events (organization_id, identity_key)
  WHERE superseded_by IS NULL
    AND identity_key IS NOT NULL
    AND identity_ns = 'eval_score';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_identity_head_eval_score;
