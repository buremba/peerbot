-- migrate:up

-- Contract phase of #1044: the 'browser'/'api' worker-claim axis was removed
-- in #1042, and #1226 (deployed) removed api_type from the query_sql allowlist
-- so no running replica emits it in scoped CTEs anymore. Nothing reads or
-- writes the column; dropping it is safe under a rolling upgrade.
ALTER TABLE public.connector_definitions DROP COLUMN IF EXISTS api_type;

-- migrate:down

ALTER TABLE public.connector_definitions
    ADD COLUMN IF NOT EXISTS api_type text DEFAULT 'api'::text NOT NULL;
