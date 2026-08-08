-- migrate:up transaction:false

-- Idempotency for eval scores (evals PR 4, lobu#2564).
--
-- The scorer writes one event per (run, metric) with
-- `identity = { ns: 'eval_score', key: '<runId>:<metric>' }`. Without a unique
-- index that key is a convention, not a guarantee: two replicas that claim the
-- same run in the same instant both probe, both see no row, and both insert —
-- the exact READ COMMITTED race 20260806120010 documents for behavior_event.
-- Double-counted scores would then move the quality stamp for free.
--
-- Keyed on the CHAIN ROOT (`supersedes_event_id IS NULL`), matching
-- idx_events_identity_root_behavior and idx_canvas_chain_root, and for the same
-- reason: insertEvent inserts the successor BEFORE stamping the predecessor's
-- superseded_by, so both rows are briefly live and a live-head index would
-- reject every ordinary supersede. A rescore supersedes the head and carries a
-- non-NULL supersedes_event_id, so it is simply not in this index.
--
-- Per-namespace by design — a namespace that wants uniqueness declares its own
-- index; `entity_identities`' single blanket index is the anti-pattern.
--
-- CONCURRENTLY (transaction:false, ONE statement per migration): db:lint bans a
-- blocking build on the hot events table, and dbmate sends a transaction:false
-- block as a single simple-query batch that CONCURRENTLY cannot share.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_events_identity_root_eval_score
  ON public.events (organization_id, identity_key)
  WHERE supersedes_event_id IS NULL
    AND identity_key IS NOT NULL
    AND identity_ns = 'eval_score';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_identity_root_eval_score;
