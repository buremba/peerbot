-- migrate:up

-- Fingerprint of the compile configuration (EXTERNAL_RUNTIME_DEPS + pipeline
-- version) that produced compiled_code. NULL on legacy rows and on rows
-- without a pipeline-produced artifact; resolveConnectorCode treats a
-- mismatch/NULL as stale and recompiles from source instead of executing a
-- bundle that may bare-import packages the runtime image no longer ships
-- (e.g. pino-era artifacts).
ALTER TABLE connector_versions ADD COLUMN compile_config_hash text;

-- migrate:down

ALTER TABLE connector_versions DROP COLUMN compile_config_hash;
