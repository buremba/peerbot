-- migrate:up transaction:false

-- One schedule per (org, client-chosen idempotency key). Partial: rows created
-- without a key (the common case) stay out of the index entirely.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS scheduled_jobs_org_idempotency_key_uniq
  ON public.scheduled_jobs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.scheduled_jobs_org_idempotency_key_uniq;
