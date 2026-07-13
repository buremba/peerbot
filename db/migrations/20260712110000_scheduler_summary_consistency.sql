-- migrate:up

-- A paused feed is not runnable. Keep the scheduler cursor structurally NULL
-- so every API consumer sees the same state, regardless of which code path
-- paused it (tool, device reconciliation, auth revocation, or soft delete).
UPDATE feeds
SET next_run_at = NULL,
    updated_at = current_timestamp
WHERE status = 'paused'
  AND next_run_at IS NOT NULL;

CREATE OR REPLACE FUNCTION clear_paused_feed_next_run_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'paused' THEN
    NEW.next_run_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feeds_clear_paused_next_run_at ON feeds;
CREATE TRIGGER feeds_clear_paused_next_run_at
BEFORE INSERT OR UPDATE OF status, next_run_at ON feeds
FOR EACH ROW
EXECUTE FUNCTION clear_paused_feed_next_run_at();

-- Repair watcher summaries created before completion paths consistently
-- stamped last_fired_at. Run creation is the durable dispatch record.
UPDATE watchers w
SET last_fired_at = latest.fired_at,
    updated_at = current_timestamp
FROM (
  SELECT watcher_id, MAX(created_at) AS fired_at
  FROM runs
  WHERE watcher_id IS NOT NULL
    AND status = 'completed'
  GROUP BY watcher_id
) latest
WHERE w.id = latest.watcher_id
  AND (w.last_fired_at IS NULL OR w.last_fired_at < latest.fired_at);

-- migrate:down

DROP TRIGGER IF EXISTS feeds_clear_paused_next_run_at ON feeds;
DROP FUNCTION IF EXISTS clear_paused_feed_next_run_at();
