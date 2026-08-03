-- migrate:up transaction:false

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'mcp_activity_scope_client_recent'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.mcp_activity_scope_client_recent';
  END IF;
END
$heal$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS mcp_activity_scope_client_recent
  ON public.mcp_client_conversations (
    organization_id,
    client_id,
    activity_kind,
    last_activity_at DESC
  )
  WHERE client_id IS NOT NULL AND call_count > 0;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.mcp_activity_scope_client_recent;
