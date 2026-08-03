-- migrate:up
ALTER TABLE public.mcp_client_conversations
  ADD COLUMN IF NOT EXISTS active_call_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS running_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS running_until timestamptz;

ALTER TABLE public.mcp_client_conversations
  DROP CONSTRAINT IF EXISTS mcp_client_conversations_active_call_count_nonnegative;

ALTER TABLE public.mcp_client_conversations
  ADD CONSTRAINT mcp_client_conversations_active_call_count_nonnegative
  CHECK (active_call_count >= 0) NOT VALID;

ALTER TABLE public.mcp_client_conversations
  VALIDATE CONSTRAINT mcp_client_conversations_active_call_count_nonnegative;

-- migrate:down
ALTER TABLE public.mcp_client_conversations
  DROP CONSTRAINT IF EXISTS mcp_client_conversations_active_call_count_nonnegative;

ALTER TABLE public.mcp_client_conversations
  DROP COLUMN IF EXISTS running_until,
  DROP COLUMN IF EXISTS running_generation,
  DROP COLUMN IF EXISTS active_call_count;
