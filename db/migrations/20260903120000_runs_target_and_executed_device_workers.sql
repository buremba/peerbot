-- Explicit placement intent and reality for device-routed runs.
--
-- target_device_worker_id: the device endpoint intended/authorized to execute
-- this run, assigned at creation (actions, syncs, approval requests).
--
-- executed_by_device_worker_id: the actual device endpoint that claimed and
-- checked out the run, written atomically at claim time.
--
-- Intentional: NO foreign key constraints on these columns. Devices can be
-- reaped or deleted, but historical runs must NEVER be deleted or have their
-- execution attribution wiped to NULL via ON DELETE SET NULL / CASCADE.

-- migrate:up transaction:false

ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS target_device_worker_id uuid,
  ADD COLUMN IF NOT EXISTS executed_by_device_worker_id uuid;

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_runs_target_device_status'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_runs_target_device_status';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_target_device_status
  ON public.runs (target_device_worker_id, status)
  WHERE target_device_worker_id IS NOT NULL AND status = 'pending';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_target_device_status;

ALTER TABLE public.runs
  DROP COLUMN IF EXISTS target_device_worker_id,
  DROP COLUMN IF EXISTS executed_by_device_worker_id;
