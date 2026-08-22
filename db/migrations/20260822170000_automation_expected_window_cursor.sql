-- migrate:up

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS next_window_start timestamptz;

COMMENT ON COLUMN automations.next_window_start IS
  'Oldest logical Automation period not yet completed; advanced only by fenced window completion.';

-- migrate:down

ALTER TABLE automations
  DROP COLUMN IF EXISTS next_window_start;
