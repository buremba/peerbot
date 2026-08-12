-- migrate:up transaction:false

-- Bounded indexed read for GET /api/<org>/deployments/latest: the mixed
-- config-changes feed cannot answer "latest succeeded deployment" without
-- scanning unbounded append-only history through the general (org, id) index.
-- Additive only — no columns or tables change. CONCURRENTLY (outside a
-- transaction) so building on the growing `events` table never blocks
-- production writes; db:lint (squawk) bans non-concurrent builds here.
--
-- Heal an INVALID carcass inline so every retry can rebuild it. Both production
-- and embedded migration runners split transaction:false sections into
-- top-level statements, so the DO block and concurrent build run unwrapped.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'events_succeeded_deployments_idx'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.events_succeeded_deployments_idx';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_succeeded_deployments_idx
  ON public.events (organization_id, id DESC)
  WHERE semantic_type = 'change'
    AND metadata->>'category' = 'deployment'
    AND metadata->>'status' = 'succeeded';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.events_succeeded_deployments_idx;
