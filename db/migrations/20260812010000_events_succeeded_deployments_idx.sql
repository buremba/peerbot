-- migrate:up
-- Bounded indexed read for GET /api/<org>/deployments/latest: the mixed
-- config-changes feed cannot answer "latest succeeded deployment" without
-- scanning unbounded append-only history through the general (org, id) index.
-- Additive only — no columns or tables change. CONCURRENTLY so building on the
-- growing `events` table never blocks production writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_succeeded_deployments_idx
  ON events (organization_id, id DESC)
  WHERE semantic_type = 'change'
    AND metadata->>'category' = 'deployment'
    AND metadata->>'status' = 'succeeded';

-- migrate:down
DROP INDEX CONCURRENTLY IF EXISTS events_succeeded_deployments_idx;
