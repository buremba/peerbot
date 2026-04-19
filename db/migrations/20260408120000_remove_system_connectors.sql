-- migrate:up

-- Migrate system connector definitions to org-scoped.
-- For every org, copy each active system connector definition that
-- the org doesn't already have (regardless of whether connections exist).

INSERT INTO connector_definitions (
  organization_id, key, name, description, version,
  auth_schema, feeds_schema, actions_schema, options_schema,
  mcp_config, openapi_config, favicon_domain, status, login_enabled
)
SELECT
  o.id,
  cd.key,
  cd.name,
  cd.description,
  cd.version,
  cd.auth_schema,
  cd.feeds_schema,
  cd.actions_schema,
  cd.options_schema,
  cd.mcp_config,
  cd.openapi_config,
  cd.favicon_domain,
  cd.status,
  cd.login_enabled
FROM connector_definitions cd
CROSS JOIN "organization" o
WHERE cd.organization_id IS NULL
  AND cd.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM connector_definitions existing
    WHERE existing.organization_id = o.id
      AND existing.key = cd.key
      AND existing.status = 'active'
  );

-- Archive all system-level connector definitions
UPDATE connector_definitions
SET status = 'archived', updated_at = NOW()
WHERE organization_id IS NULL
  AND status = 'active';

-- Drop orphaned index that only covered system-level (org IS NULL) definitions
DROP INDEX IF EXISTS idx_connector_defs_system_key;

-- migrate:down
