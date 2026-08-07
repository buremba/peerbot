-- migrate:up transaction:false

-- Which Behavior produced this event (part 3: the read index).
-- Companion to 20260807130000, split out because CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction and db:lint (squawk) bans non-concurrent
-- builds on the hot events table. One statement per transaction:false
-- migration — dbmate sends the block as one simple-query batch and
-- CONCURRENTLY can't share it.
--
-- Serves the read shape the column exists for: one Behavior's output, newest
-- first (`produced_by_behavior_id` in content-search/visibility.ts, which is
-- always org-scoped). Partial, so it indexes only produced rows (1,424 of 2.84M
-- on prod) rather than carrying a NULL entry for every event ever synced.
-- Ordered after the backfill in 20260807130010 so it is built once over the
-- final rows instead of being maintained through 945 UPDATEs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_behavior_produced
  ON public.events (organization_id, behavior_id, occurred_at DESC)
  WHERE behavior_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_behavior_produced;
