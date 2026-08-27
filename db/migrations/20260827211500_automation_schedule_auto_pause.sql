-- migrate:up
-- lobu:no-quiesce

-- Operational cost: not timed against a production-sized automations table.
-- Both columns are metadata-only additions on supported Postgres versions;
-- installing the row trigger takes a brief ACCESS EXCLUSIVE metadata lock and
-- does not scan or rewrite existing rows.
ALTER TABLE public.automations
  -- squawk-ignore prefer-bigint-over-int -- bounded circuit-breaker counter (default threshold 5), never an accumulating identifier
  ADD COLUMN IF NOT EXISTS consecutive_scheduled_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schedule_auto_paused_at timestamptz;

CREATE OR REPLACE FUNCTION public.automations_enforce_schedule_auto_pause()
RETURNS trigger AS $$
BEGIN
  IF NEW.schedule_auto_paused_at IS NOT NULL THEN
    NEW.next_run_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_automations_enforce_schedule_auto_pause
  ON public.automations;
CREATE TRIGGER trg_automations_enforce_schedule_auto_pause
  BEFORE INSERT OR UPDATE OF next_run_at, schedule_auto_paused_at
  ON public.automations
  FOR EACH ROW
  EXECUTE FUNCTION public.automations_enforce_schedule_auto_pause();

-- migrate:down

DROP TRIGGER IF EXISTS trg_automations_enforce_schedule_auto_pause
  ON public.automations;
DROP FUNCTION IF EXISTS public.automations_enforce_schedule_auto_pause();

ALTER TABLE public.automations
  DROP COLUMN IF EXISTS schedule_auto_paused_at,
  DROP COLUMN IF EXISTS consecutive_scheduled_failures;
