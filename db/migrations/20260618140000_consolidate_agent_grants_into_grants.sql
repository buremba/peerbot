-- migrate:up

-- Consolidate legacy agent_grants rows into the canonical grants table
-- (GrantStore). agent_grants was the embedded-store duplicate; production
-- enforcement has always read public.grants. ON CONFLICT keeps the grants
-- row when both tables had the same normalized pattern.

DO $$
BEGIN
    IF to_regclass('public.agent_grants') IS NOT NULL THEN
        INSERT INTO public.grants (
            organization_id,
            agent_id,
            kind,
            pattern,
            expires_at,
            granted_at,
            denied
        )
        WITH legacy AS (
            SELECT
                organization_id,
                agent_id,
                btrim(pattern) AS raw_pattern,
                expires_at,
                granted_at,
                COALESCE(denied, false) AS denied
            FROM public.agent_grants
            WHERE btrim(pattern) <> ''
        ), normalized AS (
            SELECT
                organization_id,
                agent_id,
                CASE WHEN raw_pattern LIKE '/%' THEN 'mcp_tool' ELSE 'domain' END AS kind,
                CASE
                    WHEN raw_pattern LIKE '/%' THEN raw_pattern
                    WHEN raw_pattern LIKE '*.%' THEN concat('.', lower(substring(raw_pattern FROM 3)))
                    ELSE lower(raw_pattern)
                END AS normalized_pattern,
                expires_at,
                granted_at,
                denied
            FROM legacy
        ), deduped AS (
            SELECT DISTINCT ON (organization_id, agent_id, kind, normalized_pattern)
                organization_id,
                agent_id,
                kind,
                normalized_pattern,
                expires_at,
                granted_at,
                denied
            FROM normalized
            ORDER BY organization_id, agent_id, kind, normalized_pattern, denied DESC, granted_at DESC
        )
        SELECT
            organization_id,
            agent_id,
            kind,
            normalized_pattern,
            expires_at,
            granted_at,
            denied
        FROM deduped
        ON CONFLICT (organization_id, agent_id, kind, pattern) DO NOTHING;
    END IF;
END $$;

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.agent_grants;

-- migrate:down

-- Irreversible: migrated rows cannot be distinguished from native grants, and
-- agent_grants table contents are intentionally dropped after consolidation.
