-- migrate:up
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS granted_organization_ids text[];

ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS granted_organization_ids text[];

ALTER TABLE oauth_device_codes
  ADD COLUMN IF NOT EXISTS granted_organization_ids text[];

COMMENT ON COLUMN oauth_tokens.granted_organization_ids IS
  'Immutable workspace grant snapshot copied through OAuth rotation; NULL legacy rows fail closed to organization_id';

-- migrate:down
ALTER TABLE oauth_device_codes
  DROP COLUMN IF EXISTS granted_organization_ids;

ALTER TABLE oauth_tokens
  DROP COLUMN IF EXISTS granted_organization_ids;

ALTER TABLE oauth_authorization_codes
  DROP COLUMN IF EXISTS granted_organization_ids;
