-- migrate:up

-- Encrypted, bounded copies of rich MCP tool results for host iframe reloads.
-- These are derived UI artifacts, not durable workspace events: a reload may
-- display the prior result, but must never rerun SQL, SDK code, or an action.
-- Raw host conversation and JSON-RPC call ids are SHA-256 keyed by the server
-- so they are neither exposed at rest nor large enough to overflow a btree key.
CREATE TABLE IF NOT EXISTS public.mcp_app_result_snapshots (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES public.oauth_clients(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  conversation_key text NOT NULL CHECK (length(conversation_key) = 64),
  tool_call_key text NOT NULL CHECK (length(tool_call_key) = 64),
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 120),
  -- AES-256-GCM encrypted JSON: { version, toolName, data, viewState }.
  body text NOT NULL,
  plaintext_bytes bigint NOT NULL CHECK (plaintext_bytes BETWEEN 1 AND 524288),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    organization_id,
    client_id,
    user_id,
    conversation_key,
    tool_call_key
  )
);

-- Exact restore and per-conversation cap both use the primary-key prefix. The
-- expiry index is for the single-claimant retention sweep.
-- squawk-ignore require-concurrent-index-creation -- table created immediately above; no existing rows or traffic
CREATE INDEX IF NOT EXISTS mcp_app_result_snapshots_expiry
  ON public.mcp_app_result_snapshots (expires_at);

-- migrate:down

-- squawk-ignore ban-drop-table -- derived, expiring UI artifacts introduced here
DROP TABLE IF EXISTS public.mcp_app_result_snapshots;
