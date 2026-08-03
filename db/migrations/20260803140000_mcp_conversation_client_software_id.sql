-- migrate:up
ALTER TABLE public.mcp_client_conversations
  ADD COLUMN IF NOT EXISTS client_software_id text;

UPDATE public.mcp_client_conversations mc
SET client_software_id = oc.software_id
FROM public.oauth_clients oc
WHERE mc.client_id = oc.id
  AND mc.client_software_id IS NULL;

-- Stamp at the database boundary so writes from older replicas in a rolling
-- deploy are classified before a later client deletion clears `client_id`.
CREATE OR REPLACE FUNCTION public.stamp_mcp_conversation_client_software_id()
RETURNS trigger AS $$
BEGIN
  IF NEW.client_software_id IS NULL AND NEW.client_id IS NOT NULL THEN
    SELECT software_id INTO NEW.client_software_id
    FROM public.oauth_clients
    WHERE id = NEW.client_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stamp_mcp_conversation_client_software_id
  ON public.mcp_client_conversations;
CREATE TRIGGER stamp_mcp_conversation_client_software_id
  BEFORE INSERT OR UPDATE OF client_id
  ON public.mcp_client_conversations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_mcp_conversation_client_software_id();

-- migrate:down
DROP TRIGGER IF EXISTS stamp_mcp_conversation_client_software_id
  ON public.mcp_client_conversations;
DROP FUNCTION IF EXISTS public.stamp_mcp_conversation_client_software_id();
ALTER TABLE public.mcp_client_conversations
  DROP COLUMN IF EXISTS client_software_id;
