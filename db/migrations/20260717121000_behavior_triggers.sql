-- migrate:up

-- Persist Behavior activations on the existing watcher/Behavior row. Connector
-- deliveries remain in their canonical stores (events/channel_messages); this
-- column contains only declarative routing, so no webhook or subscription table
-- is introduced.
ALTER TABLE watchers
  ADD COLUMN IF NOT EXISTS triggers jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE watchers
  DROP CONSTRAINT IF EXISTS watchers_triggers_array_check;

ALTER TABLE watchers
  ADD CONSTRAINT watchers_triggers_array_check
  CHECK (jsonb_typeof(triggers) = 'array') NOT VALID;

ALTER TABLE watchers
  VALIDATE CONSTRAINT watchers_triggers_array_check;

-- Existing scheduled Behaviors become schedule-triggered Behaviors. Keeping the
-- indexed schedule/timezone columns as a derived projection avoids rewriting the
-- mature due-schedule query while exposing one canonical public trigger model.
UPDATE watchers
SET triggers = jsonb_build_array(
  jsonb_strip_nulls(
    jsonb_build_object(
      'kind', 'schedule',
      'cron', schedule,
      'timezone', timezone,
      'execution', 'window',
      'active_run', 'coalesce',
      -- Existing scheduled watchers ran on every tick. Preserve that behavior;
      -- new Behaviors can explicitly opt into the cheap unchanged-data gate.
      'skip_if_unchanged', false
    )
  )
)
WHERE schedule IS NOT NULL
  AND triggers = '[]'::jsonb;

-- Old replicas write the indexed schedule/timezone columns directly during a
-- rolling deployment. Mirror only writes that did not also change the canonical
-- trigger array; new replicas update both representations atomically.
CREATE OR REPLACE FUNCTION sync_legacy_watcher_schedule_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $bridge$
DECLARE
  existing_schedule jsonb;
  non_schedule_triggers jsonb;
  schedule_trigger jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.triggers, '[]'::jsonb) <> '[]'::jsonb THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.triggers IS DISTINCT FROM OLD.triggers THEN
      RETURN NEW;
    END IF;
    IF NEW.schedule IS NOT DISTINCT FROM OLD.schedule
      AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT item INTO existing_schedule
  FROM jsonb_array_elements(COALESCE(NEW.triggers, '[]'::jsonb))
    WITH ORDINALITY AS entry(item, ordinal)
  WHERE item->>'kind' = 'schedule'
  ORDER BY ordinal
  LIMIT 1;

  SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
  INTO non_schedule_triggers
  FROM jsonb_array_elements(COALESCE(NEW.triggers, '[]'::jsonb))
    WITH ORDINALITY AS entry(item, ordinal)
  WHERE item->>'kind' IS DISTINCT FROM 'schedule';

  IF NEW.schedule IS NULL THEN
    NEW.triggers := non_schedule_triggers;
    RETURN NEW;
  END IF;

  schedule_trigger := COALESCE(
    existing_schedule,
    jsonb_build_object(
      'kind', 'schedule',
      'execution', 'window',
      'active_run', 'coalesce',
      'skip_if_unchanged', false
    )
  ) || jsonb_build_object('kind', 'schedule', 'cron', NEW.schedule);
  IF NEW.timezone IS NULL THEN
    schedule_trigger := schedule_trigger - 'timezone';
  ELSE
    schedule_trigger := schedule_trigger
      || jsonb_build_object('timezone', NEW.timezone);
  END IF;

  NEW.triggers := non_schedule_triggers || jsonb_build_array(schedule_trigger);
  RETURN NEW;
END
$bridge$;

DROP TRIGGER IF EXISTS sync_legacy_watcher_schedule_trigger ON watchers;
CREATE TRIGGER sync_legacy_watcher_schedule_trigger
BEFORE INSERT OR UPDATE OF schedule, timezone, triggers ON watchers
FOR EACH ROW EXECUTE FUNCTION sync_legacy_watcher_schedule_trigger();

COMMENT ON COLUMN watchers.triggers IS
  'Canonical declarative Behavior activations. schedule/timezone are derived indexed projections of the schedule trigger.';

-- Connector definitions own the event vocabulary and its delivery
-- capabilities. Persisting that catalog beside feeds/actions makes custom
-- connectors behave exactly like bundled connectors across UI, API, CLI, and
-- MCP callers without introducing a subscription table.
ALTER TABLE connector_definitions
  ADD COLUMN IF NOT EXISTS behavior_events jsonb;

ALTER TABLE connector_definitions
  DROP CONSTRAINT IF EXISTS connector_definitions_behavior_events_array_check;

ALTER TABLE connector_definitions
  ADD CONSTRAINT connector_definitions_behavior_events_array_check
  CHECK (
    behavior_events IS NULL
    OR jsonb_typeof(behavior_events) = 'array'
  ) NOT VALID;

ALTER TABLE connector_definitions
  VALIDATE CONSTRAINT connector_definitions_behavior_events_array_check;

COMMENT ON COLUMN connector_definitions.behavior_events IS
  'Connector-owned Behavior event catalog, including filters, defaults, and source-delivery capabilities.';

-- migrate:down

DROP TRIGGER IF EXISTS sync_legacy_watcher_schedule_trigger ON watchers;
DROP FUNCTION IF EXISTS sync_legacy_watcher_schedule_trigger();

ALTER TABLE connector_definitions
  DROP CONSTRAINT IF EXISTS connector_definitions_behavior_events_array_check;

ALTER TABLE connector_definitions
  DROP COLUMN IF EXISTS behavior_events;

ALTER TABLE watchers
  DROP CONSTRAINT IF EXISTS watchers_triggers_array_check;

ALTER TABLE watchers
  DROP COLUMN IF EXISTS triggers;
