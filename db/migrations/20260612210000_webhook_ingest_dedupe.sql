-- migrate:up transaction:false

-- Idempotency for inbound webhook deliveries (#1235).
--
-- `events.connection_id` is a bigint FK to connector `connections` (NOT
-- `agent_connections`), and `events.origin_id` is only indexed, not unique —
-- so webhook ingest (`connector_key = 'webhook:<agentConnectionId>'`) brings
-- its own uniqueness: one row per (org, webhook connection, delivery key).
-- Provider redeliveries (same dedupe header value, or same body hash) become
-- true no-ops — the handler pre-checks, and a concurrent duplicate surfaces
-- as a 23505 it treats as success.
--
-- Partial on the webhook namespace so connector-sourced events (which reuse
-- origin_id across superseding versions) are untouched.
--
-- Operational cost: CONCURRENTLY (events is the hot ~1M+ row table; a plain
-- CREATE INDEX would block writes for the build). The predicate matches zero
-- rows today — the build is one table scan with reads+writes flowing, and the
-- resulting index is empty. If a deploy retry hits the CONCURRENTLY+IF NOT
-- EXISTS invalid-index trap, see docs/MIGRATIONS.md.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS events_webhook_ingest_dedupe
  ON events (organization_id, connector_key, origin_id)
  WHERE connector_key LIKE 'webhook:%';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS events_webhook_ingest_dedupe;
