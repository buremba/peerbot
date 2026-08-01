-- migrate:up transaction:false

-- Behavior reaction scripts are retried after a failure. Their durable writes
-- need a database-enforced idempotency key so a retry cannot create a second
-- knowledge event or notification after the first attempt committed.
--
-- The key lives in a Lobu-reserved metadata field because both knowledge and
-- notification records are append-only events. It is absent from ordinary and
-- domain-authored metadata, keeping this index small and avoiding collisions
-- with historical event schemas. Organization scope lets separate workspaces
-- reuse the same producer key safely.
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
      AND c.relname = 'idx_events_org_idempotency_key'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_events_org_idempotency_key';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_events_org_idempotency_key
  ON public.events (organization_id, (metadata->>'_lobu_idempotency_key'))
  WHERE metadata ? '_lobu_idempotency_key';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_org_idempotency_key;
