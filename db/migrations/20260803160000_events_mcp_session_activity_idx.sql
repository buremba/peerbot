-- migrate:up transaction:false

-- Activity resolves one already-materialized MCP conversation or session to
-- the transport session ids that wrote its audit and interaction events. This
-- expression
-- index keeps the exact-session lookup off the growing events history.
--
-- Do not restrict it to current rows: explicit include_superseded reads use the
-- same filter. Heal an invalid carcass so an interrupted concurrent build is
-- safe to retry.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'events_mcp_session_activity'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.events_mcp_session_activity';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_mcp_session_activity
  ON public.events (
    organization_id,
    (metadata->>'mcp_session_id'),
    occurred_at DESC,
    id DESC
  )
  WHERE metadata->>'mcp_session_id' IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.events_mcp_session_activity;
