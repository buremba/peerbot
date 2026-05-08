-- migrate:up

UPDATE public.agents
SET mcp_servers = (mcp_servers - 'lobu') || jsonb_build_object('lobu-memory', mcp_servers->'lobu'),
    updated_at = now()
WHERE mcp_servers ? 'lobu'
  AND NOT (mcp_servers ? 'lobu-memory');

UPDATE public.agents
SET mcp_servers = mcp_servers - 'lobu',
    updated_at = now()
WHERE mcp_servers ? 'lobu';

UPDATE public.agents a
SET pre_approved_tools = COALESCE((
  SELECT jsonb_agg(DISTINCT mapped.value)
  FROM (
    SELECT CASE
      WHEN tool.value #>> '{}' LIKE '/mcp/lobu/tools/%'
        OR tool.value #>> '{}' LIKE '/mcp/lobu-memory/tools/%'
        THEN to_jsonb('/mcp/lobu-memory/tools/*'::text)
      ELSE tool.value
    END AS value
    FROM jsonb_array_elements(COALESCE(a.pre_approved_tools, '[]'::jsonb)) AS tool(value)

    UNION ALL

    SELECT to_jsonb('/mcp/lobu-memory/tools/*'::text) AS value
    WHERE a.mcp_servers ? 'lobu-memory'
  ) AS mapped
), '[]'::jsonb),
    updated_at = now()
WHERE a.mcp_servers ? 'lobu-memory'
   OR EXISTS (
     SELECT 1
     FROM jsonb_array_elements(COALESCE(a.pre_approved_tools, '[]'::jsonb)) AS tool(value)
     WHERE tool.value #>> '{}' LIKE '/mcp/lobu/tools/%'
        OR tool.value #>> '{}' LIKE '/mcp/lobu-memory/tools/%'
   );

INSERT INTO public.grants (agent_id, kind, pattern, expires_at, granted_at, denied)
SELECT g.agent_id,
       g.kind,
       '/mcp/lobu-memory/tools/*',
       CASE
         WHEN bool_or(g.expires_at IS NULL) THEN NULL::timestamptz
         ELSE max(g.expires_at)
       END,
       now(),
       bool_or(g.denied)
FROM public.grants g
WHERE g.kind = 'mcp_tool'
  AND (g.pattern LIKE '/mcp/lobu/tools/%' OR g.pattern LIKE '/mcp/lobu-memory/tools/%')
GROUP BY g.agent_id, g.kind
ON CONFLICT (agent_id, kind, pattern) DO UPDATE SET
  expires_at = CASE
    WHEN public.grants.expires_at IS NULL THEN EXCLUDED.expires_at
    WHEN EXCLUDED.expires_at IS NULL THEN public.grants.expires_at
    ELSE LEAST(public.grants.expires_at, EXCLUDED.expires_at)
  END,
  granted_at = EXCLUDED.granted_at,
  denied = public.grants.denied OR EXCLUDED.denied;

DELETE FROM public.grants
WHERE kind = 'mcp_tool'
  AND pattern LIKE '/mcp/lobu/tools/%';

-- migrate:down

UPDATE public.agents
SET mcp_servers = (mcp_servers - 'lobu-memory') || jsonb_build_object('lobu', mcp_servers->'lobu-memory'),
    updated_at = now()
WHERE mcp_servers ? 'lobu-memory'
  AND NOT (mcp_servers ? 'lobu');

UPDATE public.agents a
SET pre_approved_tools = COALESCE((
  SELECT jsonb_agg(DISTINCT CASE
    WHEN tool.value #>> '{}' LIKE '/mcp/lobu-memory/tools/%'
      THEN to_jsonb('/mcp/lobu/tools/*'::text)
    ELSE tool.value
  END)
  FROM jsonb_array_elements(COALESCE(a.pre_approved_tools, '[]'::jsonb)) AS tool(value)
), '[]'::jsonb),
    updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(a.pre_approved_tools, '[]'::jsonb)) AS tool(value)
  WHERE tool.value #>> '{}' LIKE '/mcp/lobu-memory/tools/%'
);

INSERT INTO public.grants (agent_id, kind, pattern, expires_at, granted_at, denied)
SELECT g.agent_id,
       g.kind,
       '/mcp/lobu/tools/*',
       CASE
         WHEN bool_or(g.expires_at IS NULL) THEN NULL::timestamptz
         ELSE max(g.expires_at)
       END,
       now(),
       bool_or(g.denied)
FROM public.grants g
WHERE g.kind = 'mcp_tool'
  AND g.pattern LIKE '/mcp/lobu-memory/tools/%'
GROUP BY g.agent_id, g.kind
ON CONFLICT (agent_id, kind, pattern) DO UPDATE SET
  expires_at = CASE
    WHEN public.grants.expires_at IS NULL THEN EXCLUDED.expires_at
    WHEN EXCLUDED.expires_at IS NULL THEN public.grants.expires_at
    ELSE LEAST(public.grants.expires_at, EXCLUDED.expires_at)
  END,
  granted_at = EXCLUDED.granted_at,
  denied = public.grants.denied OR EXCLUDED.denied;

DELETE FROM public.grants
WHERE kind = 'mcp_tool'
  AND pattern LIKE '/mcp/lobu-memory/tools/%';
