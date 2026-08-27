-- migrate:up
ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS authorization_grant_type text;

COMMENT ON COLUMN oauth_tokens.authorization_grant_type IS
  'Issuing OAuth flow (authorization_code or device_code); NULL legacy rows carrying private device scopes fail closed and must re-authorize';

-- Existing rows predate issuing-flow provenance, so private device scopes
-- cannot be distinguished from the former authorization-code scope leak.
-- Force reauthorization before old application replicas can keep accepting
-- them during a rolling deploy.
UPDATE oauth_tokens
SET revoked_at = NOW()
WHERE revoked_at IS NULL
  AND authorization_grant_type IS NULL
  AND regexp_split_to_array(btrim(COALESCE(scope, '')), E'\\s+')
      && ARRAY['device_worker:run', 'connections:token']::text[];

-- NOT VALID avoids a table scan but still rejects every new/updated live row.
-- This makes old replicas fail closed when they try to mint a private-scope
-- token without the new device-code provenance column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'oauth_tokens_private_scopes_require_device_grant'
      AND conrelid = 'oauth_tokens'::regclass
  ) THEN
    ALTER TABLE oauth_tokens
      ADD CONSTRAINT oauth_tokens_private_scopes_require_device_grant
      CHECK (
        revoked_at IS NOT NULL
        OR COALESCE(authorization_grant_type = 'device_code', false)
        OR NOT (
          regexp_split_to_array(btrim(COALESCE(scope, '')), E'\\s+')
            && ARRAY['device_worker:run', 'connections:token']::text[]
        )
      ) NOT VALID;
  END IF;
END $$;

-- migrate:down
ALTER TABLE oauth_tokens
  DROP CONSTRAINT IF EXISTS oauth_tokens_private_scopes_require_device_grant;

ALTER TABLE oauth_tokens
  DROP COLUMN IF EXISTS authorization_grant_type;
