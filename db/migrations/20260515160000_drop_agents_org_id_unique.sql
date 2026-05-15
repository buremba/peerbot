-- migrate:up
-- Drop the parallel `UNIQUE (organization_id, id)` added in 20260515120000.
-- It was meant as schema-prep for the eventual PK swap to (organization_id,
-- id), but it actively broke `ON CONFLICT (id) DO NOTHING/UPDATE` callers.
--
-- Why: Postgres' `ON CONFLICT (X)` only suppresses violations of the unique
-- constraint matching exactly column set X. Adding a second unique constraint
-- that overlaps with the PK means inserts can fail on the new constraint
-- before reaching the PK conflict — and ON CONFLICT (id) doesn't catch it.
-- Surfaced in `__tests__/integration/.../race-mcp` where parallel inserts of
-- `(org-a, race-mcp-0)` started throwing `agents_organization_id_id_key`
-- duplicates instead of being silently de-duped by the existing
-- `ON CONFLICT (id) DO NOTHING` clause.
--
-- The PK on `(id)` already enforces global uniqueness, which subsumes
-- `(organization_id, id)` uniqueness — the new constraint was logically
-- redundant. Phase C of the per-org PK migration will swap the PK directly
-- without needing a parallel constraint as a stepping stone.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_organization_id_id_key;

-- migrate:down
ALTER TABLE agents
  ADD CONSTRAINT agents_organization_id_id_key UNIQUE (organization_id, id);
