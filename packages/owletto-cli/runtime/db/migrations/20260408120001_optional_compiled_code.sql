-- migrate:up
ALTER TABLE connector_versions ALTER COLUMN compiled_code DROP NOT NULL;

-- migrate:down
UPDATE connector_versions SET compiled_code = '' WHERE compiled_code IS NULL;
ALTER TABLE connector_versions ALTER COLUMN compiled_code SET NOT NULL;
