-- migrate:up

-- Deleting an agent used to unlink its chat channels through the
-- agent_channel_bindings FK cascade. watchers has no FK on agent_id, so
-- without this trigger a deleted agent's Behaviors stay active and chat
-- routing keeps resolving a nonexistent agent (unrunnable turns, stale
-- bound-channel targets, undeliverable notifications). Archive every active
-- Behavior owned by the agent — none of them can run once the agent is gone.
--
-- agents has composite PK (organization_id, id). Scope the archive to the
-- deleted row's organization so a shared agent id in another tenant is not
-- corrupted.
CREATE OR REPLACE FUNCTION archive_behaviors_for_deleted_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE watchers w
  SET status = 'archived', updated_at = current_timestamp
  WHERE w.status = 'active'
    AND w.organization_id = OLD.organization_id
    AND w.agent_id = OLD.id;
  RETURN OLD;
END
$archive$;

DROP TRIGGER IF EXISTS archive_behaviors_for_deleted_agent ON agents;
CREATE TRIGGER archive_behaviors_for_deleted_agent
AFTER DELETE ON agents
FOR EACH ROW
EXECUTE FUNCTION archive_behaviors_for_deleted_agent();

-- Backfill: archive Behaviors already orphaned by agent deletes that happened
-- before this trigger existed. Correlate on organization_id so a live agent
-- with the same id in another org does not keep a foreign orphan active (or
-- incorrectly spare a local orphan).
UPDATE watchers w
SET status = 'archived', updated_at = current_timestamp
WHERE w.status = 'active'
  AND w.agent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM agents a
    WHERE a.id = w.agent_id
      AND a.organization_id = w.organization_id
  );

-- migrate:down

DROP TRIGGER IF EXISTS archive_behaviors_for_deleted_agent ON agents;
DROP FUNCTION IF EXISTS archive_behaviors_for_deleted_agent();
