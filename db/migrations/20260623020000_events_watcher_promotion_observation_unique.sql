-- migrate:up transaction:false

-- P2 (keyed-entity promotion): make the watcher-promotion `observation` event idempotent under N>1.
-- promoteKeyedEntities emits one observation per (window, stable_key) with a deterministic origin_id
-- `watcher-observation:<watcher>:<window>:<key>`. The emit was a check-then-insert (TOCTOU-racy: two
-- concurrent completions of the same window could both pass the SELECT and both INSERT a duplicate).
-- This partial unique index backs an ON CONFLICT DO NOTHING so the second writer is a no-op.
--
-- CONCURRENTLY (transaction:false) because `events` is the append-only hot table — an exclusive-lock
-- build would block ingest (docs/MIGRATIONS.md). The partial predicate scopes the constraint to ONLY
-- these observations; events.origin_id is otherwise non-unique by design (see 20260612210000). No
-- backfill precondition: this is a brand-new event shape, so no pre-existing rows can collide.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_events_watcher_promotion_observation_unique
  ON public.events (organization_id, origin_id)
  WHERE semantic_type = 'observation' AND metadata ->> 'category' = 'watcher_promotion';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_events_watcher_promotion_observation_unique;
