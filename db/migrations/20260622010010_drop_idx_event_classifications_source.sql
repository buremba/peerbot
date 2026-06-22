-- migrate:up transaction:false

-- Drop idx_event_classifications_source: a plain btree(source) on
-- event_classifications that is byte-identical to idx_cc_source (also
-- btree(source) on the same table). idx_cc_source serves every lookup, so this
-- second copy is pure write + disk overhead. Keep idx_cc_source. Redundancy is
-- structural, independent of usage stats.
--
-- CONCURRENTLY (transaction:false, single statement) so the catalog drop never
-- contends with readers/writers of event_classifications during the Helm hook.
-- One statement per transaction:false migration: dbmate sends the whole up
-- block as one simple-query batch and Postgres wraps a multi-statement batch in
-- an implicit transaction that CONCURRENTLY refuses to run inside.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_event_classifications_source;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_classifications_source
    ON public.event_classifications USING btree (source);
