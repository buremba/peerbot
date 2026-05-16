-- migrate:up

-- Drop 8 indexes that pg_stat_user_indexes reported `idx_scan = 0` after 28h
-- of prod uptime. Together they cost ~5.16 GB of disk + RAM plus write
-- amplification on every events / event_embeddings INSERT.
--
-- pg_stat_statements over the same 28h shows zero calls touching the query
-- shapes these indexes serve: no `<->` / `<=>` / `<#>` vector ops (ivfflat
-- ANN), no `payload_text ILIKE` or `similarity(payload_text, …)` (trigram
-- GIN), no `@@ to_tsquery(…)` (search_tsv GIN). The code paths in
-- packages/server/src/utils/content-search.ts exist, they're just not hit
-- in prod today. If/when they get exercised, rebuild CONCURRENTLY — the
-- query plans degrade to seq scans + filter until the index is back.
--
-- The migration uses plain `DROP INDEX` (not CONCURRENTLY) because
-- dbmate's `transaction:false` directive doesn't actually exit the
-- transaction block when running against the `pq` driver — see the
-- comment in 20260426130001_db_integrity_cleanup_concurrent.sql.
-- Operator runbook: for prod application, run `DROP INDEX CONCURRENTLY`
-- manually first (see docs/MIGRATIONS.md "When dbmate fails in prod"
-- → transaction:false recipe), then run dbmate to record this row in
-- schema_migrations. On fresh installs / CI / dev the events table is
-- empty so the brief ACCESS EXCLUSIVE is irrelevant.

DROP INDEX IF EXISTS public.idx_events_embedding;
DROP INDEX IF EXISTS public.idx_events_raw_content_trgm;
DROP INDEX IF EXISTS public.idx_events_search_tsv;
DROP INDEX IF EXISTS public.idx_events_entity_ids_occurred_at;
DROP INDEX IF EXISTS public.idx_events_origin_parent_id;
DROP INDEX IF EXISTS public.idx_events_thread_lookup;
DROP INDEX IF EXISTS public.idx_events_run_id;
DROP INDEX IF EXISTS public.idx_events_type;

-- migrate:down

CREATE INDEX IF NOT EXISTS idx_events_embedding
    ON public.event_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists='1000');
CREATE INDEX IF NOT EXISTS idx_events_raw_content_trgm
    ON public.events USING gin (payload_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_events_search_tsv
    ON public.events USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_events_entity_ids_occurred_at
    ON public.events USING btree ((entity_ids[1]), occurred_at DESC, id DESC)
    WHERE ((entity_ids IS NOT NULL) AND (entity_ids <> '{}'::bigint[]));
CREATE INDEX IF NOT EXISTS idx_events_origin_parent_id
    ON public.events USING btree (origin_parent_id);
CREATE INDEX IF NOT EXISTS idx_events_thread_lookup
    ON public.events USING btree (origin_parent_id, occurred_at)
    WHERE (origin_parent_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_run_id
    ON public.events USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_events_type
    ON public.events USING btree (origin_type) WHERE (origin_type IS NOT NULL);
