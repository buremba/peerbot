-- migrate:up transaction:false

-- Bounded indexed read for GET /api/<org>/deployments/latest: the mixed
-- config-changes feed cannot answer "latest succeeded deployment" without
-- scanning unbounded append-only history through the general (org, id) index.
-- Additive only — no columns or tables change. CONCURRENTLY (outside a
-- transaction) so building on the growing `events` table never blocks
-- production writes; db:lint (squawk) bans non-concurrent builds here.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_succeeded_deployments_idx
  ON public.events (organization_id, id DESC)
  WHERE semantic_type = 'change'
    AND metadata->>'category' = 'deployment'
    AND metadata->>'status' = 'succeeded';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.events_succeeded_deployments_idx;
