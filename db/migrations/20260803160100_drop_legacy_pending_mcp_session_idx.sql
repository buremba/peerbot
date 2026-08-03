-- migrate:up transaction:false

-- Pending-interaction lookup moved to the existing materialized activity row
-- plus exact event provenance. The earlier partial index served only the
-- removed history-derived sessions endpoint.
DROP INDEX CONCURRENTLY IF EXISTS public.events_pending_interaction_mcp_session;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_pending_interaction_mcp_session
  ON public.events (organization_id, (metadata->>'mcp_session_id'))
  WHERE interaction_status = 'pending'
    AND interaction_type <> 'none'
    AND metadata->>'mcp_session_id' IS NOT NULL
    AND superseded_by IS NULL;
