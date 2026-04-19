-- migrate:up
ALTER TABLE connector_definitions ADD COLUMN IF NOT EXISTS default_connection_config jsonb;

-- migrate:down
ALTER TABLE connector_definitions DROP COLUMN IF EXISTS default_connection_config;
