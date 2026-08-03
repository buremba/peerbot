-- migrate:up

-- `conversation_id` predates the capability-aware UI and stores either the
-- host conversation id or, when the host exposes none, the MCP transport
-- session id. The writer always stores the transport separately in
-- `transport_session_ids`, so this discriminator records the exact semantic
-- boundary without guessing from an id's format or client name.
--
-- This cannot be a stored generated column: adding one rewrites the existing
-- table under ACCESS EXCLUSIVE. A database-side write invariant also keeps old
-- replicas correct during a rolling deploy, before every application writer
-- knows about the new column.
ALTER TABLE public.mcp_client_conversations
  ADD COLUMN IF NOT EXISTS activity_kind text;

UPDATE public.mcp_client_conversations
SET activity_kind = CASE
  WHEN transport_session_ids ? conversation_id THEN 'session'
  ELSE 'conversation'
END
WHERE activity_kind IS NULL;

CREATE OR REPLACE FUNCTION public.set_mcp_client_activity_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.activity_kind := CASE
    WHEN NEW.transport_session_ids ? NEW.conversation_id THEN 'session'
    ELSE 'conversation'
  END;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS mcp_client_conversations_activity_kind
  ON public.mcp_client_conversations;

CREATE TRIGGER mcp_client_conversations_activity_kind
BEFORE INSERT OR UPDATE OF conversation_id, transport_session_ids
ON public.mcp_client_conversations
FOR EACH ROW
EXECUTE FUNCTION public.set_mcp_client_activity_kind();

-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration in a transaction
ALTER TABLE public.mcp_client_conversations ADD CONSTRAINT mcp_client_conversations_activity_kind_valid CHECK (activity_kind IS NOT NULL AND activity_kind IN ('conversation', 'session')) NOT VALID;

-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration in a transaction
ALTER TABLE public.mcp_client_conversations VALIDATE CONSTRAINT mcp_client_conversations_activity_kind_valid;

-- squawk-ignore prefer-robust-stmts -- the validated constraint proves the backfill removed every NULL; dbmate wraps the migration
ALTER TABLE public.mcp_client_conversations ALTER COLUMN activity_kind SET NOT NULL;

-- migrate:down

DROP TRIGGER IF EXISTS mcp_client_conversations_activity_kind
  ON public.mcp_client_conversations;

DROP FUNCTION IF EXISTS public.set_mcp_client_activity_kind();

ALTER TABLE public.mcp_client_conversations
  DROP COLUMN IF EXISTS activity_kind;
