-- migrate:up transaction:false

-- Second half of the dedupe-key swap (see 20260709140000): now that the
-- window-aware v2 index exists, drop the old window-blind one. Separate migration
-- because two CONCURRENTLY statements can't share a `transaction:false` file (the
-- batch runs in an implicit transaction Postgres forbids CONCURRENTLY inside).
DROP INDEX CONCURRENTLY IF EXISTS public.runs_entity_change_pending_dedupe;

-- migrate:down transaction:false

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS runs_entity_change_pending_dedupe
  ON public.runs (organization_id, action_key, md5(action_input::text))
  WHERE run_type = 'internal'
    AND action_key IN ('entity_field_change', 'entity_change')
    AND approval_status = 'pending'
    AND status = 'pending';
