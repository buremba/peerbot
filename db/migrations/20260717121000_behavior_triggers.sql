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

-- Clean cut: the app always writes triggers together with the indexed
-- schedule/timezone projections. No dual-write trigger for old schedule-only
-- writers — those paths are gone with the Behavior public API.

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

ALTER TABLE connector_definitions
  DROP CONSTRAINT IF EXISTS connector_definitions_behavior_events_array_check;

ALTER TABLE connector_definitions
  DROP COLUMN IF EXISTS behavior_events;

ALTER TABLE watchers
  DROP CONSTRAINT IF EXISTS watchers_triggers_array_check;

ALTER TABLE watchers
  DROP COLUMN IF EXISTS triggers;
