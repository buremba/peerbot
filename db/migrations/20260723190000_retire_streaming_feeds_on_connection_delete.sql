-- Retire a connection's streaming (chat) feeds when the connection is tombstoned.
--
-- A streaming feed is keyed by the numeric `connections.id` and, until now, was
-- soft-deleted only on an explicit Behavior unlink (`softDeleteStreamingChannelFeed`)
-- — nothing retired it when its *connection* died. When a connection was retired
-- (for example, when a Slack Grid workspace was re-installed under a different
-- tenant key), its streaming feeds stayed LIVE pointing at a dead row.
-- `20260723160000_retire_leaked_chat_feeds.sql` cleaned up duplicate rows that had
-- already accumulated, but did not prevent new orphans.
--
-- This closes the leak at the source: a streaming feed cannot outlive its
-- connection. The moment a connection is tombstoned, its streaming feeds are
-- retired in the same transaction — the exact companion to the existing
-- `archive_chat_behaviors_for_deleted_connection` trigger, which already archives
-- the chat-link Behaviors on the same event. A DB trigger (not the app-level
-- reconciler) is deliberate: it fires for every path that updates the connection
-- tombstone, so the invariant does not depend on each caller reconciling feeds.
--
-- Matches `softDeleteStreamingChannelFeed` semantics exactly (deleted_at + paused)
-- so trigger-retired and app-retired rows are indistinguishable. Only `streaming`
-- feeds are touched; collected and virtual feeds are unchanged.

-- migrate:up

CREATE OR REPLACE FUNCTION retire_streaming_feeds_for_deleted_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $retire$
BEGIN
  UPDATE feeds
  SET deleted_at = current_timestamp,
      status = 'paused',
      updated_at = current_timestamp
  WHERE connection_id = NEW.id
    AND kind = 'streaming'
    AND deleted_at IS NULL;
  RETURN NEW;
END
$retire$;

DROP TRIGGER IF EXISTS retire_streaming_feeds_for_deleted_connection
  ON connections;
CREATE TRIGGER retire_streaming_feeds_for_deleted_connection
AFTER UPDATE OF deleted_at ON connections
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION retire_streaming_feeds_for_deleted_connection();

-- Backfill: retire streaming feeds still live on already-tombstoned connections.
-- The prior one-shot only retired rows that had a live in-org duplicate; this
-- retires the rest, since none of them can route (their connection is dead). Runs
-- after the trigger exists so the invariant is true for existing rows too.
UPDATE feeds f
SET deleted_at = current_timestamp,
    status = 'paused',
    updated_at = current_timestamp
FROM connections dead
WHERE f.deleted_at IS NULL
  AND f.kind = 'streaming'
  AND f.connection_id = dead.id
  AND dead.deleted_at IS NOT NULL;

-- migrate:down

DROP TRIGGER IF EXISTS retire_streaming_feeds_for_deleted_connection
  ON connections;
DROP FUNCTION IF EXISTS retire_streaming_feeds_for_deleted_connection();

-- The backfill is data cleanup. Restoring those feeds while their connections
-- remain tombstoned would violate the invariant, so it is not reversed.
