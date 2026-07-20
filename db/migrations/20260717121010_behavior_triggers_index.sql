-- migrate:up transaction:false

-- Event activation uses a coarse @> lookup before applying exact connector,
-- connection, event-type, and match filters in code. Build the supporting GIN
-- index without blocking writes to existing Behavior rows.
--
-- INVALID-carcass heal for this index runs first in the companion migration
-- 20260717121009_behavior_triggers_index_heal.sql. This file is intentionally
-- a SINGLE statement: dbmate runs a multi-statement transaction:false body in
-- one implicit transaction, which CREATE INDEX CONCURRENTLY refuses.
--
-- Partial predicate is status-only. `triggers <> '[]'` is unprovable from the
-- activation `@>` lookup, so the planner would never use this index with that
-- extra clause. Empty trigger arrays still fail `@>` and are harmless.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_watchers_triggers_gin
  ON watchers USING gin (triggers jsonb_path_ops)
  WHERE status = 'active';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_watchers_triggers_gin;
