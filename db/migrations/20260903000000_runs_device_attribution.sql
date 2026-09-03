-- The hard cut cannot safely guess an endpoint for an existing unpinned
-- required-capability connection. Stop before changing schema so the operator
-- can pin or archive each row explicitly and retry the migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.connections c
    JOIN public.connector_definitions cd
      ON cd.organization_id = c.organization_id
     AND cd.key = c.connector_key
     AND cd.status = 'active'
     AND cd.required_capability IS NOT NULL
    WHERE c.deleted_at IS NULL
      AND c.device_worker_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate device routing: active required-capability connections are unpinned; pin or archive each row explicitly before retrying';
  END IF;
END $$;

ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS target_device_worker_id uuid,
  ADD COLUMN IF NOT EXISTS executed_by_device_worker_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_target_device_worker_id_fkey'
  ) THEN
    ALTER TABLE public.runs
      ADD CONSTRAINT runs_target_device_worker_id_fkey
      FOREIGN KEY (target_device_worker_id)
      REFERENCES public.device_workers(id)
      ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_executed_by_device_worker_id_fkey'
  ) THEN
    ALTER TABLE public.runs
      ADD CONSTRAINT runs_executed_by_device_worker_id_fkey
      FOREIGN KEY (executed_by_device_worker_id)
      REFERENCES public.device_workers(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- These are read-side filters and claim diagnostics, not history scans.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS runs_target_device_worker_id_idx
  ON public.runs (target_device_worker_id, created_at DESC, id DESC)
  WHERE target_device_worker_id IS NOT NULL;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS runs_executed_by_device_worker_id_idx
  ON public.runs (executed_by_device_worker_id, created_at DESC, id DESC)
  WHERE executed_by_device_worker_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assert_required_capability_connection_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$fn$
BEGIN
  IF NEW.deleted_at IS NULL
     AND NEW.device_worker_id IS NULL
     AND EXISTS (
       SELECT 1
       FROM public.connector_definitions cd
       WHERE cd.organization_id = NEW.organization_id
         AND cd.key = NEW.connector_key
         AND cd.status = 'active'
         AND cd.required_capability IS NOT NULL
     ) THEN
    RAISE EXCEPTION
      'required-capability connection % must name an exact device_worker_id', NEW.id;
  END IF;
  RETURN NEW;
END;
$$fn$;

CREATE OR REPLACE FUNCTION public.assert_required_capability_definition_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$fn$
BEGIN
  IF NEW.status = 'active'
     AND NEW.required_capability IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.connections c
       WHERE c.organization_id = NEW.organization_id
         AND c.connector_key = NEW.key
         AND c.deleted_at IS NULL
         AND c.device_worker_id IS NULL
     ) THEN
    RAISE EXCEPTION
      'required-capability connector % cannot be active while an executable connection is unpinned', NEW.key;
  END IF;
  RETURN NEW;
END;
$$fn$;

DROP TRIGGER IF EXISTS connections_required_capability_binding ON public.connections;
CREATE TRIGGER connections_required_capability_binding
  BEFORE INSERT OR UPDATE OF connector_key, organization_id, device_worker_id, deleted_at
  ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_required_capability_connection_binding();

DROP TRIGGER IF EXISTS connector_definitions_required_capability_binding
  ON public.connector_definitions;
CREATE TRIGGER connector_definitions_required_capability_binding
  AFTER INSERT OR UPDATE OF key, organization_id, required_capability, status
  ON public.connector_definitions
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_required_capability_definition_binding();

COMMENT ON COLUMN public.runs.target_device_worker_id IS
  'Immutable endpoint intent captured when device-backed work is created; NULL means the run is not device-targeted or predates this hard cut.';
COMMENT ON COLUMN public.runs.executed_by_device_worker_id IS
  'Immutable endpoint that atomically claimed device-backed work; NULL means no device claimed it or the device was deleted and the run_metadata snapshot is authoritative.';

-- migrate:down transaction:false
DROP TRIGGER IF EXISTS connector_definitions_required_capability_binding
  ON public.connector_definitions;
DROP TRIGGER IF EXISTS connections_required_capability_binding ON public.connections;
DROP FUNCTION IF EXISTS public.assert_required_capability_definition_binding();
DROP FUNCTION IF EXISTS public.assert_required_capability_connection_binding();
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_target_device_worker_id_fkey,
  DROP CONSTRAINT IF EXISTS runs_executed_by_device_worker_id_fkey;
DROP INDEX IF EXISTS public.runs_target_device_worker_id_idx;
DROP INDEX IF EXISTS public.runs_executed_by_device_worker_id_idx;
ALTER TABLE public.runs
  DROP COLUMN IF EXISTS target_device_worker_id,
  DROP COLUMN IF EXISTS executed_by_device_worker_id;
