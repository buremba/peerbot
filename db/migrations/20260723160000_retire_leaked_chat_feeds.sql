-- Retire streaming chat feeds leaked onto retired connections.
--
-- A streaming feed is keyed by the numeric `connections.id` and is soft-deleted
-- only when a Behavior is explicitly unlinked — no trigger retires feeds when a
-- connection is. So whenever a Slack workspace was re-installed under a
-- different tenant key (a Grid workspace is recorded under its enterprise `E…`
-- id or its workspace `T…` id depending on how it was installed), the
-- replacement connection got its own feed while the previous generation's feed
-- stayed LIVE, pointing at a dead row. They accumulate one per install.
--
-- Prod (org_lobucrm) carries two such orphans for one DM channel — feeds 434
-- (connection 419) and 437 (connection 430) — while feed 450 serves that same
-- channel on the live connection 448.
--
-- Scoped by ORGANIZATION + CHANNEL, deliberately NOT by tenant key: the retired
-- generations carry different `external_tenant_id`s (that key changing is what
-- forked them in the first place), so a tenant match would retire nothing.
-- Matching on `feed_key` alone is far too broad — unrelated connectors reuse
-- feed keys (`reviews`, `content` and `home_feed` all collide in prod), and
-- retiring those would silently stop their ingestion.
--
-- A feed is retired only when the SAME org already has a LIVE streaming feed for
-- the SAME channel on a LIVE connection, so every row retired here is strictly a
-- duplicate of one that keeps routing. An org whose only feeds for a channel sit
-- on dead connections keeps them rather than losing its last one.
--
-- Behaviors are deliberately NOT repaired here. Prod's one archived chat-link
-- Behavior (25, naming the retired connection 430) was already superseded by an
-- identical ACTIVE Behavior (48, on the live connection 448) that the reinstall
-- created three minutes before the archive — so archiving 25 was correct.
-- Reviving it would leave two active Behaviors on one channel and, because
-- resolution takes LIMIT 1 ordered by `updated_at DESC`, the revived row would
-- displace the working one.
--
-- Scope: this cleans up existing rows. It does not change how feeds bind, and it
-- does not stop a future tenant-key change from leaking another feed — that is
-- an install-identity concern, tracked separately.

-- migrate:up

-- `status` is set alongside `deleted_at` only so a retired row does not read
-- back as 'active'. Scheduling already filters on `deleted_at IS NULL` (and
-- skips streaming feeds entirely, see `check-due-feeds`), so `deleted_at` alone
-- is what actually retires the feed.
UPDATE feeds f
SET deleted_at = current_timestamp,
    status = 'paused',
    updated_at = current_timestamp
FROM connections dead
WHERE f.deleted_at IS NULL
  AND f.kind = 'streaming'
  AND f.connection_id = dead.id
  AND dead.deleted_at IS NOT NULL
  AND dead.credential_mode IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM feeds live_feed
    JOIN connections live ON live.id = live_feed.connection_id
    WHERE live_feed.deleted_at IS NULL
      AND live_feed.kind = 'streaming'
      AND live_feed.feed_key = f.feed_key
      AND live.deleted_at IS NULL
      AND live.credential_mode IS NOT NULL
      AND live.organization_id = dead.organization_id
      AND live.connector_key = dead.connector_key
  );

-- migrate:down

-- Data cleanup: each retired row duplicated a live feed, so restoring them would
-- only re-create the leak.
SELECT 1;
