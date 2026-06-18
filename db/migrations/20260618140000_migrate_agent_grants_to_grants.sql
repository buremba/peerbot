-- migrate:up

-- Consolidate legacy agent_grants rows into the canonical grants table
-- (GrantStore). agent_grants was the embedded-store duplicate; production
-- enforcement has always read public.grants. ON CONFLICT keeps the grants
-- row when both tables had the same pattern (unlikely — agent_grants was
-- never wired to enforcement).

INSERT INTO public.grants (
    organization_id,
    agent_id,
    kind,
    pattern,
    expires_at,
    granted_at,
    denied
)
SELECT
    organization_id,
    agent_id,
    CASE WHEN pattern LIKE '/%' THEN 'mcp_tool' ELSE 'domain' END,
    pattern,
    expires_at,
    granted_at,
    COALESCE(denied, false)
FROM public.agent_grants
ON CONFLICT (organization_id, agent_id, kind, pattern) DO NOTHING;

-- migrate:down

-- Irreversible: migrated rows cannot be distinguished from native grants.