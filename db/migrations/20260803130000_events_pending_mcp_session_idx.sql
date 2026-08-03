-- migrate:up transaction:false

-- Support the pending-interaction count on the MCP client sessions read path
-- (`packages/server/src/lobu/client-session-routes.ts`).
--
-- That query maps the org's live pending interactions to materialized MCP
-- conversations through their transport-session ids.
-- Without a supporting index the scan widens as `events` grows, even though
-- the pending working set stays bounded. This partial index covers only rows
-- that are still pending, so the lookup is proportional to outstanding work
-- rather than to total history.
--
-- Operational cost: CONCURRENTLY (events is the hot ~1M+ row table, so a plain
-- CREATE INDEX would block writes for the build). Heal an invalid carcass first
-- so a crashed build can be retried safely.

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'events_pending_interaction_mcp_session'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.events_pending_interaction_mcp_session';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_pending_interaction_mcp_session
  ON public.events (organization_id, (metadata->>'mcp_session_id'))
  WHERE interaction_status = 'pending'
    AND interaction_type <> 'none'
    AND metadata->>'mcp_session_id' IS NOT NULL
    AND superseded_by IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.events_pending_interaction_mcp_session;
