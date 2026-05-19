-- migrate:up

-- Token revocation kill-switch table, previously created at runtime by
-- `RevokedTokenStore.ensureSchema()` (packages/server/src/gateway/auth/
-- revoked-token-store.ts) and again separately by the `lobu token revoke`
-- CLI command (packages/cli/src/commands/token.ts). Two runtime sites
-- meant two copies of the schema definition; one drifting from the other
-- was waiting to happen.
--
-- Promoting to a real migration so the schema source (db/schema.sql)
-- reflects production reality. Both runtime CREATE blocks are removed in
-- the same change set.
--
-- `IF NOT EXISTS` so this is a no-op on any deployment where the gateway
-- or CLI already created the table at runtime — same name, same column
-- types.

CREATE TABLE IF NOT EXISTS public.revoked_tokens (
    jti text PRIMARY KEY,
    expires_at timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx
    ON public.revoked_tokens (expires_at);

-- migrate:down

DROP INDEX IF EXISTS public.revoked_tokens_expires_at_idx;
DROP TABLE IF EXISTS public.revoked_tokens;
