-- migrate:up transaction:false

-- Drop idx_events_identity_fact_lookup: partial index over
-- `semantic_type = 'identity_fact'` events, built for the identity-fact
-- engine's org+namespace+normalizedValue rule matching. Same rationale as
-- 20260801010010: the engine (its only reader and the only writer of these
-- rows) is deleted, so the index only taxes writes to `events`. The
-- identity_fact rows themselves stay — `events` is append-only.
--
-- CONCURRENTLY needs transaction:false and a single statement; see
-- 20260801010010 for the dbmate mechanics.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_identity_fact_lookup;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_identity_fact_lookup
    ON public.events (organization_id, (metadata ->> 'namespace'), (metadata ->> 'normalizedValue'))
    WHERE semantic_type = 'identity_fact';
