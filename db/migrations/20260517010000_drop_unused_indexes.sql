-- migrate:up

-- Drop 4 indexes that pg_stat_user_indexes reported `idx_scan = 0` after 28h
-- of prod uptime AND are not referenced from any active code path.
--
-- A larger set (4 more, ~5 GB combined) was originally bundled here but
-- review caught they're not actually unused — they're dormant. The three
-- big search indexes (`idx_events_embedding`, `idx_events_raw_content_trgm`,
-- `idx_events_search_tsv`) are explicitly used by the ANN/fulltext/trigram
-- branches of `approximate_candidate_search` in
-- `packages/server/src/utils/content-search.ts:1707-1733`. The `search()`
-- agent tool path threads through there; prod just hasn't called it in
-- 28h, but a single user-initiated search would now time out at 6s and
-- return empty results without those indexes (`content-search.ts:1850-1863`).
-- Similarly `idx_events_run_id` backs the "view in memory" filter
-- (`content-query-filters.ts:197-201`); rare, but a real path.
--
-- Keep those four until either (a) the dormant features are removed in
-- code, or (b) measured prod traffic confirms they're abandoned.
--
-- What remains is small but still real write amplification: each kept
-- INSERT into events updates these btrees. Combined size ~66 MB —
-- modest reclaim, but zero downside since the underlying queries don't
-- exist anywhere in the codebase today (verified by grep).
--
-- Plain `DROP INDEX` (not CONCURRENTLY) is used because dbmate's
-- `transaction:false` directive doesn't actually exit the transaction
-- block against the `pq` driver — see the comment in
-- 20260426130001_db_integrity_cleanup_concurrent.sql. These 4 indexes
-- are all small btrees so the ACCESS EXCLUSIVE on `events` during the
-- drop is sub-second; no operator runbook needed.

DROP INDEX IF EXISTS public.idx_events_entity_ids_occurred_at;
DROP INDEX IF EXISTS public.idx_events_origin_parent_id;
DROP INDEX IF EXISTS public.idx_events_thread_lookup;
DROP INDEX IF EXISTS public.idx_events_type;

-- migrate:down

CREATE INDEX IF NOT EXISTS idx_events_entity_ids_occurred_at
    ON public.events USING btree ((entity_ids[1]), occurred_at DESC, id DESC)
    WHERE ((entity_ids IS NOT NULL) AND (entity_ids <> '{}'::bigint[]));
CREATE INDEX IF NOT EXISTS idx_events_origin_parent_id
    ON public.events USING btree (origin_parent_id);
CREATE INDEX IF NOT EXISTS idx_events_thread_lookup
    ON public.events USING btree (origin_parent_id, occurred_at)
    WHERE (origin_parent_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_type
    ON public.events USING btree (origin_type) WHERE (origin_type IS NOT NULL);
