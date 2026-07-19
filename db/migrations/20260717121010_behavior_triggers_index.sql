-- migrate:up transaction:false

-- Event activation uses a coarse @> lookup before applying exact connector,
-- connection, event-type, and match filters in code. Build the supporting GIN
-- index without blocking writes to existing Behavior rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_watchers_triggers_gin
  ON watchers USING gin (triggers jsonb_path_ops)
  WHERE status = 'active' AND triggers <> '[]'::jsonb;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS idx_watchers_triggers_gin;
