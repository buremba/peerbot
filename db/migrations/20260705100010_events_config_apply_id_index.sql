-- migrate:up transaction:false

-- Expression index on metadata->>'apply_id' for deployment grouping:
-- the deployment detail route fetches all config events of one apply run,
-- and the summary-ingestion POST dedupes retried CLI posts by apply_id.
-- Partial on apply_id presence — only rows written under an
-- `x-lobu-apply-id` header (lobu apply runs) carry it. CONCURRENTLY
-- (transaction:false, one statement per squawk) so the build never blocks
-- writes on the high-write events table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_config_apply_id
  ON public.events (organization_id, (metadata->>'apply_id'))
  WHERE semantic_type = 'change'
    AND metadata->>'apply_id' IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_config_apply_id;
