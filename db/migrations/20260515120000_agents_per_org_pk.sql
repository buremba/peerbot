-- migrate:up
-- Phase A of moving `agents` from a globally-unique `id` PK to a per-org
-- composite PK `(organization_id, id)`. The application has always treated
-- agents as org-scoped (every read/delete/list filters by organization_id),
-- so the global PK is a latent footgun: two orgs cannot share an agent ID,
-- and a stale agent in one org silently blocks another org from using the
-- same name.
--
-- This phase is INTENTIONALLY NON-BREAKING. It only:
--   1. Adds an `organization_id` column to each FK-holding child table
--      (NULLABLE — backfilled here, set NOT NULL in a later phase once the
--      app-code refactor lands so every INSERT writes the value).
--   2. Backfills `organization_id` from agents (no orphan rows in prod).
--   3. Adds a parallel UNIQUE constraint on `agents (organization_id, id)`
--      so the schema is ready for the eventual PK swap.
--   4. Adds composite indexes on each child table so the upcoming
--      org-scoped query patterns are fast from day one.
--
-- The single-column PK on agents and the single-column FKs on child tables
-- stay in place. App code keeps working unmodified. The PK swap and FK
-- composite migration ship in a separate PR after the storage interfaces
-- are plumbed with `organization_id`.

-- ── 1. Add organization_id columns (nullable for now).
ALTER TABLE agent_grants            ADD COLUMN organization_id text;
ALTER TABLE agent_connections       ADD COLUMN organization_id text;
ALTER TABLE agent_users             ADD COLUMN organization_id text;
ALTER TABLE agent_channel_bindings  ADD COLUMN organization_id text;
ALTER TABLE grants                  ADD COLUMN organization_id text;

-- ── 2. Backfill from agents.
UPDATE agent_grants           SET organization_id = a.organization_id FROM agents a WHERE agent_grants.agent_id            = a.id;
UPDATE agent_connections      SET organization_id = a.organization_id FROM agents a WHERE agent_connections.agent_id       = a.id;
UPDATE agent_users            SET organization_id = a.organization_id FROM agents a WHERE agent_users.agent_id             = a.id;
UPDATE agent_channel_bindings SET organization_id = a.organization_id FROM agents a WHERE agent_channel_bindings.agent_id  = a.id;
UPDATE grants                 SET organization_id = a.organization_id FROM agents a WHERE grants.agent_id                  = a.id;

-- ── 3. Parallel UNIQUE on agents (organization_id, id). The single-column
--     PK on (id) stays — this is purely additive and signals to readers
--     that org-scoped uniqueness is the eventual model. The PK swap in a
--     later migration will drop this UNIQUE and reuse the index for the
--     new composite PK.
ALTER TABLE agents
  ADD CONSTRAINT agents_organization_id_id_key UNIQUE (organization_id, id);

-- ── 4. Composite indexes on child tables for upcoming org-scoped queries.
CREATE INDEX agent_grants_org_agent_idx           ON agent_grants           (organization_id, agent_id);
CREATE INDEX agent_connections_org_agent_idx      ON agent_connections      (organization_id, agent_id);
CREATE INDEX agent_users_org_agent_idx            ON agent_users            (organization_id, agent_id);
CREATE INDEX agent_channel_bindings_org_agent_idx ON agent_channel_bindings (organization_id, agent_id);
CREATE INDEX grants_org_agent_idx                 ON grants                 (organization_id, agent_id);

-- migrate:down
DROP INDEX IF EXISTS grants_org_agent_idx;
DROP INDEX IF EXISTS agent_channel_bindings_org_agent_idx;
DROP INDEX IF EXISTS agent_users_org_agent_idx;
DROP INDEX IF EXISTS agent_connections_org_agent_idx;
DROP INDEX IF EXISTS agent_grants_org_agent_idx;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_organization_id_id_key;

ALTER TABLE grants                  DROP COLUMN IF EXISTS organization_id;
ALTER TABLE agent_channel_bindings  DROP COLUMN IF EXISTS organization_id;
ALTER TABLE agent_users             DROP COLUMN IF EXISTS organization_id;
ALTER TABLE agent_connections       DROP COLUMN IF EXISTS organization_id;
ALTER TABLE agent_grants            DROP COLUMN IF EXISTS organization_id;
