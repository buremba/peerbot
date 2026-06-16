-- migrate:up transaction:false

-- Drop idx_events_source_embedding: a plain btree(event_id) on event_embeddings
-- that exactly duplicates event_embeddings_pkey (also btree(event_id)). The PK
-- serves every lookup the secondary did, so this is pure write + disk overhead
-- on a hot ~15 GB / ~1.4M-row table. Redundancy is structural — independent of
-- usage stats.
--
-- CONCURRENTLY (transaction:false, single statement) so the catalog drop never
-- contends with readers/writers of event_embeddings during the Helm hook. One
-- statement per transaction:false migration: dbmate sends the whole up block as
-- one simple-query batch and Postgres wraps a multi-statement batch in an
-- implicit transaction that CONCURRENTLY refuses to run inside.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_source_embedding;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_source_embedding
    ON public.event_embeddings (event_id);
