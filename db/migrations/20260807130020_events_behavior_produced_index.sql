-- migrate:up transaction:false

-- Which Behavior produced this event (part 3: the read index).
--
-- Its own migration because CREATE INDEX CONCURRENTLY cannot run in a
-- transaction and squawk bans non-concurrent builds on `events`. One statement
-- per transaction:false migration — dbmate sends the block as a single
-- simple-query batch, which CONCURRENTLY cannot share.
--
-- Serves the read shape the column exists for: one Behavior's output, newest
-- first (always org-scoped). Partial, so it indexes only produced rows (1,424
-- of 2.84M on prod) instead of a NULL entry per event ever synced. Ordered
-- after the backfill so it is built once over final rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_behavior_produced
  ON public.events (organization_id, behavior_id, occurred_at DESC)
  WHERE behavior_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_behavior_produced;
