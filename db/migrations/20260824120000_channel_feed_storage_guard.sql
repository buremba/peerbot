-- Make channel-feed lifecycle depend on the canonical storage marker rather
-- than the transitional feeds.kind column. Capability-era writers dual-write
-- kind/virtual only for pre-capability replicas during the rolling window; the
-- new runtime invariant must therefore follow config.store.

-- migrate:up

DROP TRIGGER IF EXISTS retire_streaming_feeds_for_deleted_connection ON connections;
DROP TRIGGER IF EXISTS guard_streaming_feed_connection ON feeds;
DROP TRIGGER IF EXISTS retire_channel_feeds_for_deleted_connection ON connections;
DROP TRIGGER IF EXISTS guard_channel_feed_connection ON feeds;
DROP FUNCTION IF EXISTS retire_streaming_feeds_for_deleted_connection();
DROP FUNCTION IF EXISTS guard_streaming_feed_connection();

CREATE OR REPLACE FUNCTION retire_channel_feeds_for_deleted_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $retire$
BEGIN
  UPDATE feeds
  SET deleted_at = current_timestamp,
      status = 'paused',
      updated_at = current_timestamp
  WHERE connection_id = NEW.id
    AND config ->> 'store' = 'channel_messages'
    AND deleted_at IS NULL;
  RETURN NEW;
END
$retire$;

CREATE TRIGGER retire_channel_feeds_for_deleted_connection
AFTER UPDATE OF deleted_at ON connections
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION retire_channel_feeds_for_deleted_connection();

CREATE OR REPLACE FUNCTION guard_channel_feed_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  connection_deleted_at timestamptz;
BEGIN
  IF COALESCE(NEW.config ->> 'store', 'events') <> 'channel_messages'
     OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT deleted_at
  INTO connection_deleted_at
  FROM connections
  WHERE id = NEW.connection_id
  FOR SHARE;

  IF FOUND AND connection_deleted_at IS NOT NULL THEN
    NEW.deleted_at = current_timestamp;
    NEW.status = 'paused';
    NEW.updated_at = current_timestamp;
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER guard_channel_feed_connection
BEFORE INSERT OR UPDATE OF connection_id, config, deleted_at ON feeds
FOR EACH ROW
EXECUTE FUNCTION guard_channel_feed_connection();

UPDATE feeds f
SET deleted_at = current_timestamp,
    status = 'paused',
    updated_at = current_timestamp
FROM connections dead
WHERE f.deleted_at IS NULL
  AND f.config ->> 'store' = 'channel_messages'
  AND f.connection_id = dead.id
  AND dead.deleted_at IS NOT NULL;

-- migrate:down

-- Restore the old discriminator for rows created by capability-era writers
-- before restoring the previous trigger definitions.
UPDATE feeds
SET kind = 'streaming', virtual = false
WHERE config ->> 'store' = 'channel_messages';

DROP TRIGGER IF EXISTS guard_channel_feed_connection ON feeds;
DROP FUNCTION IF EXISTS guard_channel_feed_connection();
DROP TRIGGER IF EXISTS retire_channel_feeds_for_deleted_connection ON connections;
DROP FUNCTION IF EXISTS retire_channel_feeds_for_deleted_connection();

CREATE FUNCTION retire_streaming_feeds_for_deleted_connection()
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

CREATE TRIGGER retire_streaming_feeds_for_deleted_connection
AFTER UPDATE OF deleted_at ON connections
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION retire_streaming_feeds_for_deleted_connection();

CREATE FUNCTION guard_streaming_feed_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  connection_deleted_at timestamptz;
BEGIN
  IF NEW.kind <> 'streaming' OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT deleted_at
  INTO connection_deleted_at
  FROM connections
  WHERE id = NEW.connection_id
  FOR SHARE;

  IF FOUND AND connection_deleted_at IS NOT NULL THEN
    NEW.deleted_at = current_timestamp;
    NEW.status = 'paused';
    NEW.updated_at = current_timestamp;
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER guard_streaming_feed_connection
BEFORE INSERT OR UPDATE OF connection_id, kind, deleted_at ON feeds
FOR EACH ROW
EXECUTE FUNCTION guard_streaming_feed_connection();
