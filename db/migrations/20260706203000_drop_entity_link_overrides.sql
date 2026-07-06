-- migrate:up

ALTER TABLE public.connector_definitions
    DROP COLUMN IF EXISTS entity_link_overrides;

-- migrate:down

ALTER TABLE public.connector_definitions
    ADD COLUMN IF NOT EXISTS entity_link_overrides jsonb;

COMMENT ON COLUMN public.connector_definitions.entity_link_overrides IS
    'Legacy per-install override of removed entityLinks rules.';
