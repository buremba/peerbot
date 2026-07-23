-- Retire a connection's streaming (chat) feeds when the connection is tombstoned.
--
-- A streaming feed is keyed by the numeric `connections.id` and, until now, was
-- soft-deleted only on an explicit Behavior unlink (`softDeleteStreamingChannelFeed`)
-- — nothing retired it when its *connection* died. So every time a connection was
-- retired (e.g. a Slack Grid workspace re-installed under a different tenant key,
-- which mints a new connection and tombstones the old one), the previous
-- generation's streaming feed stayed LIVE pointing at a dead row. One leaked per
-- retirement; `20260723160000_retire_leaked_chat_feeds.sql` mopped up the rows that
-- had already accumulated in prod, but did nothing to stop the next one.
--
-- This closes the leak at the source: a streaming feed cannot outlive its
-- connection. The moment a connection is tombstoned, its streaming feeds are
-- retired in the same transaction — the exact companion to the existing
-- `archive_chat_behaviors_for_deleted_connection` trigger, which already archives
-- the chat-link Behaviors on the same event. A DB trigger (not the app-level
-- reconciler) is deliberate: it fires no matter how the connection was tombstoned
-- — tool call, admin SQL, or cascade — so the invariant holds without every code
-- path having to remember to reconcile.
--
-- Matches `softDeleteStreamingChannelFeed` semantics exactly (deleted_at + paused)
-- so trigger-retired and app-retired rows are indistinguishable. Only `streaming`
-- feeds are touched: collected/virtual feeds on a retired connection are handled by
-- their own lifecycles and are out of scope here.

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

-- The backfill is data cleanup: retired rows only duplicated dead connections, so
-- restoring them would only re-create the leak. Not reversed.
