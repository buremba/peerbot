-- migrate:up
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS location_label text;

CREATE TABLE IF NOT EXISTS public.mcp_client_conversations (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  client_identity text NOT NULL,
  conversation_id text NOT NULL,
  transport_session_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_id text REFERENCES public.oauth_clients(id) ON DELETE SET NULL,
  user_id text,
  agent_id text,
  title text,
  last_action text NOT NULL,
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  call_count bigint NOT NULL DEFAULT 0,
  failed_count bigint NOT NULL DEFAULT 0,
  first_activity_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, client_identity, conversation_id),
  CONSTRAINT mcp_client_conversations_tools_array CHECK (jsonb_typeof(tools) = 'array'),
  CONSTRAINT mcp_client_conversations_transport_sessions_array
    CHECK (jsonb_typeof(transport_session_ids) = 'array')
);

-- squawk-ignore require-concurrent-index-creation -- table created immediately above
CREATE INDEX IF NOT EXISTS mcp_client_conversations_recent
  ON public.mcp_client_conversations (organization_id, last_activity_at DESC);

-- One-time compatibility backfill. Runtime reads never aggregate this history.
WITH calls AS (
  SELECT
    e.organization_id,
    e.client_id AS client_identity,
    e.metadata->>'mcp_session_id' AS conversation_id,
    jsonb_build_array(e.metadata->>'mcp_session_id') AS transport_session_ids,
    max(e.client_id) AS client_id,
    max(e.created_by) AS user_id,
    max(e.metadata->>'agent_id') AS agent_id,
    (array_agg(e.payload_data->>'tool_name' ORDER BY e.occurred_at DESC))[1] AS last_action,
    jsonb_agg(DISTINCT e.payload_data->>'tool_name') AS tools,
    count(*) AS call_count,
    count(*) FILTER (WHERE (e.payload_data->>'success')::boolean IS NOT TRUE) AS failed_count,
    min(e.occurred_at) AS first_activity_at,
    max(e.occurred_at) AS last_activity_at
  FROM public.events e
  WHERE e.semantic_type = 'audit'
    AND e.origin_type = 'tool_invocation'
    AND e.client_id IS NOT NULL
    AND e.metadata->>'mcp_session_id' IS NOT NULL
    AND e.payload_data->>'tool_name' IS NOT NULL
    AND e.occurred_at > now() - interval '14 days'
  GROUP BY e.organization_id, e.client_id, e.metadata->>'mcp_session_id'
)
INSERT INTO public.mcp_client_conversations (
  organization_id, client_identity, conversation_id, transport_session_ids,
  client_id, user_id, agent_id, last_action, tools, call_count, failed_count,
  first_activity_at, last_activity_at
)
SELECT organization_id, client_identity, conversation_id, transport_session_ids,
  client_id, user_id, agent_id, last_action, tools, call_count, failed_count,
  first_activity_at, last_activity_at
FROM calls
ON CONFLICT (organization_id, client_identity, conversation_id) DO NOTHING;

-- migrate:down
-- squawk-ignore ban-drop-table -- rollback for the table introduced above
DROP TABLE IF EXISTS public.mcp_client_conversations;
ALTER TABLE public.conversations DROP COLUMN IF EXISTS location_label;
