-- migrate:up transaction:false

-- Support the pending-interaction count on the MCP client sessions read path
-- (`packages/server/src/lobu/client-session-routes.ts`).
--
-- That query groups the org's live pending interactions by mcp session id.
-- Without a supporting index the scan widens as `events` grows, even though
-- the pending working set stays bounded. This partial index covers only rows
-- that are still pending, so the lookup is proportional to outstanding work
-- rather than to total history.
--
-- Operational cost: CONCURRENTLY (events is the hot ~1M+ row table, so a plain
-- CREATE INDEX would block writes for the build). The predicate matches only
-- currently-pending rows, so the resulting index is small. If a deploy retry
-- hits the CONCURRENTLY + IF NOT EXISTS invalid-index trap, see
-- docs/MIGRATIONS.md.

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_pending_interaction_mcp_session
  ON events (organization_id, (metadata->>'mcp_session_id'))
  WHERE interaction_status = 'pending';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS events_pending_interaction_mcp_session;
