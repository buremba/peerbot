-- migrate:up

-- `principal_kind` discriminates the synthetic install-operator row from
-- real humans. The install operator is auto-provisioned at first
-- `lobu run` boot (see ensureInstallOperator in
-- packages/server/src/auth/install-operator.ts) so headless installs (CI,
-- containers, /tmp scaffolds) can sign in without a browser. Every
-- surface that previously filtered humans (signup count, member lists,
-- password reset, magic link, OAuth account-linking) excludes
-- principal_kind = 'install_operator' via the isInstallOperator helper.
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS principal_kind text NOT NULL DEFAULT 'human';

-- Small index to keep the carve-out predicate (and the 'is there a real
-- human on this install?' check in auth/config.ts) cheap.
CREATE INDEX IF NOT EXISTS idx_user_principal_kind
  ON "user" (principal_kind);

-- migrate:down

DROP INDEX IF EXISTS idx_user_principal_kind;
ALTER TABLE "user" DROP COLUMN IF EXISTS principal_kind;
