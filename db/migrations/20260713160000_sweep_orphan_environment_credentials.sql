-- migrate:up

-- Sweep orphaned runtime-environment credentials left behind by environment
-- deletions that ran before `deleteEnvironment` purged them. Each environment's
-- vault rows are named `environment:<id>:<field>` (see environmentSecretName()
-- in provider-secrets.ts); delete every such row whose embedded <id> — the
-- segment between the two colons — has no matching `environments` row.
--
-- `agent_secrets` is NOT the append-only `events` table, so a plain DELETE is
-- correct and required: every swept row is a decryptable provider token (eg a
-- Vercel access token) whose owning environment is already gone. Survivors —
-- secrets for environments that still exist — are untouched. The `name LIKE
-- 'environment:%'` predicate is served by agent_secrets_name_prefix_idx
-- (text_pattern_ops), so only the environment-prefixed rows are scanned.
DELETE FROM agent_secrets
WHERE name LIKE 'environment:%'
  AND split_part(name, ':', 2) NOT IN (SELECT id FROM environments);

-- migrate:down

-- No-op: the swept rows were orphans with no owning environment, so there is
-- nothing to restore.
