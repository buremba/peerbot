-- migrate:up

-- Adds the `passkey` table required by @better-auth/passkey. Each row is a
-- WebAuthn credential: bound to a user, identified by `credential_id` (the
-- credential's external id the browser reports), with `public_key` used to
-- verify subsequent authentication assertions. `counter` is the WebAuthn
-- signCount used to detect cloned authenticators.
--
-- Stored separately from `account` because account.providerId is unique-per-
-- user-per-provider, but a user can have many passkeys (one per
-- device/browser).

CREATE TABLE IF NOT EXISTS "passkey" (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  "publicKey"      TEXT NOT NULL,
  "userId"         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "credentialID"   TEXT NOT NULL,
  counter          BIGINT NOT NULL DEFAULT 0,
  "deviceType"     TEXT NOT NULL,
  "backedUp"       BOOLEAN NOT NULL DEFAULT FALSE,
  transports       TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aaguid           TEXT
);

CREATE INDEX IF NOT EXISTS passkey_user_id_idx     ON "passkey"("userId");
CREATE INDEX IF NOT EXISTS passkey_credential_id_idx ON "passkey"("credentialID");

-- migrate:down

DROP TABLE IF EXISTS "passkey";
