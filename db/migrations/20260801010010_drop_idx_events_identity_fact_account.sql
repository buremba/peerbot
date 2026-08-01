-- migrate:up transaction:false

-- Drop idx_events_identity_fact_account: partial index over
-- `semantic_type = 'identity_fact'` events, built for the identity-fact
-- engine's per-account fact diffing (revocation on connector refresh). The
-- engine is deleted in this change, and it was the only writer of
-- identity_fact events and the only reader of this access path — the rows it
-- covers are now frozen history, so the index is pure write/disk overhead on
-- the hot `events` table.
--
-- CONCURRENTLY (transaction:false, single statement) so the catalog drop never
-- contends with readers/writers of events during the Helm hook. One statement
-- per transaction:false migration: dbmate sends the whole up block as one
-- simple-query batch and Postgres wraps a multi-statement batch in an implicit
-- transaction that CONCURRENTLY refuses to run inside.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_identity_fact_account;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_identity_fact_account
    ON public.events (connector_key, (metadata ->> 'providerStableId'), (metadata ->> 'namespace'))
    WHERE semantic_type = 'identity_fact';
