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

-- Conversation runtime metadata is write-time materialized for web and
-- platform rows. `running_message_id` is the generation guard: a late terminal
-- response may clear only the turn it belongs to, never a newer turn in the
-- same Slack/web conversation. `running_until` makes crashed workers expire.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS tool_call_count bigint,
  ADD COLUMN IF NOT EXISTS last_tool_name text,
  ADD COLUMN IF NOT EXISTS running_message_id text,
  ADD COLUMN IF NOT EXISTS running_until timestamptz;

-- Legacy/rejected rows have no authoritative runtime count. Keep that state as
-- NULL instead of claiming zero, and repair an earlier application of this
-- migration that may have installed NOT NULL DEFAULT 0.
-- squawk-ignore prefer-robust-stmts -- unreleased shape correction; the migration runner wraps this section in a transaction
ALTER TABLE public.conversations ALTER COLUMN tool_call_count DROP DEFAULT;

-- squawk-ignore prefer-robust-stmts,ban-drop-not-null -- unreleased shape correction; clients in the same change accept NULL and the migration runner wraps this section in a transaction
ALTER TABLE public.conversations ALTER COLUMN tool_call_count DROP NOT NULL;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_tool_call_count_nonnegative;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_tool_call_count_nonnegative
  CHECK (tool_call_count >= 0) NOT VALID;

ALTER TABLE public.conversations
  VALIDATE CONSTRAINT conversations_tool_call_count_nonnegative;

-- migrate:down
ALTER TABLE public.mcp_client_conversations
  DROP CONSTRAINT IF EXISTS mcp_client_conversations_active_call_count_nonnegative;

ALTER TABLE public.mcp_client_conversations
  DROP COLUMN IF EXISTS running_until,
  DROP COLUMN IF EXISTS running_generation,
  DROP COLUMN IF EXISTS active_call_count;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_tool_call_count_nonnegative;

ALTER TABLE public.conversations
  DROP COLUMN IF EXISTS running_until,
  DROP COLUMN IF EXISTS running_message_id,
  DROP COLUMN IF EXISTS last_tool_name,
  DROP COLUMN IF EXISTS tool_call_count;
