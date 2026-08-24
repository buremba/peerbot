-- migrate:up transaction:false

-- Operational cost: the nullable column add is metadata-only. The backfill
-- scans runs once and updates at most one row per Automation; it was not timed
-- against production-sized data in this worktree.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS last_completed_window_start timestamptz;

COMMENT ON COLUMN automations.last_completed_window_start IS
  'Latest completed non-event Automation window period.';

-- Keep the scalar projection current for every qualifying completed Automation
-- run-row write. This trigger sorts after
-- advance_automation_window_projection_from_run, so a legacy NULL projection is
-- initialized before its granularity is checked.
CREATE OR REPLACE FUNCTION public.record_automation_last_completed_window_from_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  projection_granularity text;
  completed_start timestamptz;
BEGIN
  SELECT window_projection_granularity
  INTO projection_granularity
  FROM public.automations
  WHERE id = NEW.automation_id
    AND organization_id = NEW.organization_id
  FOR UPDATE;

  IF NOT FOUND OR projection_granularity IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.approved_input->>'granularity' IN ('daily', 'weekly', 'monthly', 'quarterly')
     AND NEW.approved_input->>'granularity' <> projection_granularity THEN
    RETURN NEW;
  END IF;

  completed_start := date_trunc(
    CASE projection_granularity
      WHEN 'daily' THEN 'day'
      WHEN 'weekly' THEN 'week'
      WHEN 'monthly' THEN 'month'
      ELSE 'quarter'
    END,
    (NEW.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC'
  ) AT TIME ZONE 'UTC';

  UPDATE public.automations
  SET last_completed_window_start = GREATEST(
        last_completed_window_start,
        completed_start
      ),
      updated_at = current_timestamp
  WHERE id = NEW.automation_id
    AND organization_id = NEW.organization_id
    AND window_projection_granularity = projection_granularity;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_automation_last_completed_window_from_run ON public.runs;
CREATE TRIGGER record_automation_last_completed_window_from_run
  AFTER INSERT OR UPDATE OF
    status, action_output, approved_input, automation_id, run_type, organization_id
  ON public.runs
  FOR EACH ROW
  WHEN (
    NEW.run_type = 'automation'
    AND NEW.status = 'completed'
    AND NEW.action_output IS NOT NULL
    AND NEW.automation_id IS NOT NULL
    AND NEW.organization_id IS NOT NULL
    AND NEW.approved_input->>'window_start' IS NOT NULL
    AND COALESCE(NEW.approved_input->>'dispatch_source', 'scheduled') <> 'event'
  )
  EXECUTE FUNCTION public.record_automation_last_completed_window_from_run();

-- History is scanned once during migration. Runtime reads use only the scalar
-- Automation-row projection.
WITH automation_granularity AS (
  SELECT
    a.id,
    COALESCE(
      a.window_projection_granularity,
      CASE
        WHEN a.schedule IS NULL THEN 'weekly'
        WHEN cardinality(regexp_split_to_array(trim(a.schedule), E'\\s+')) < 5 THEN 'weekly'
        WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[4] <> '*'
          AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] <> '*' THEN 'quarterly'
        WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] <> '*'
          AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[4] = '*' THEN 'monthly'
        WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[5] <> '*'
          AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] = '*' THEN 'weekly'
        WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] <> '*'
          AND (regexp_split_to_array(trim(a.schedule), E'\\s+'))[3] = '*' THEN 'daily'
        WHEN (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] = '*'
          OR (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] LIKE '%/%'
          OR (regexp_split_to_array(trim(a.schedule), E'\\s+'))[2] LIKE '%,%' THEN 'daily'
        ELSE 'weekly'
      END
    ) AS granularity
  FROM automations a
), completed_periods AS (
  SELECT
    r.automation_id,
    CASE granularity.granularity
      WHEN 'daily' THEN date_trunc('day', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHEN 'weekly' THEN date_trunc('week', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHEN 'monthly' THEN date_trunc('month', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ELSE date_trunc('quarter', (r.approved_input->>'window_start')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    END AS period_start
  FROM runs r
  JOIN automation_granularity granularity ON granularity.id = r.automation_id
  WHERE r.run_type = 'automation'
    AND r.status = 'completed'
    AND r.action_output IS NOT NULL
    AND COALESCE(r.approved_input->>'dispatch_source', 'scheduled') <> 'event'
    AND r.approved_input->>'window_start' IS NOT NULL
    AND (
      r.approved_input->>'granularity' IS NULL
      OR r.approved_input->>'granularity' NOT IN ('daily', 'weekly', 'monthly', 'quarterly')
      OR r.approved_input->>'granularity' = granularity.granularity
    )
), latest_completion AS (
  SELECT automation_id, max(period_start) AS period_start
  FROM completed_periods
  GROUP BY automation_id
)
UPDATE automations automation
SET last_completed_window_start = GREATEST(
  automation.last_completed_window_start,
  latest.period_start
)
FROM latest_completion latest
WHERE automation.id = latest.automation_id;

-- migrate:down transaction:false

DROP TRIGGER IF EXISTS record_automation_last_completed_window_from_run ON public.runs;
DROP FUNCTION IF EXISTS public.record_automation_last_completed_window_from_run();

ALTER TABLE automations
  DROP COLUMN IF EXISTS last_completed_window_start;
