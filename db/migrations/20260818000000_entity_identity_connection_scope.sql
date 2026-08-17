-- migrate:up

-- Identity scope: does an identifier mean the same thing across connections?
--
-- `idx_entity_identities_live_unique` is `(organization_id, namespace,
-- identifier)`, so two connections in the same org that share a namespace
-- collapse onto one entity. Namespaces come from connector manifests, not from
-- anything the platform controls: two ERP connections against two different
-- tenants both declaring `erp_customer` resolve `CARI-001` in tenant A to the
-- entity minted for `CARI-001` in tenant B. Nothing errors — the second
-- connection's attribution silently accretes traits onto the first's entity.
--
-- The fix is NOT to add `connection_id` to the index. That column is
-- PROVENANCE: it records which connection first wrote the row, and it is set on
-- every connector-written identity including ones that are legitimately
-- org-wide. Indexing it would split identities that must stay collapsed — in
-- production today one organization shares `slack_channel_id` across three
-- connections and `slack_user_id` across two, and the same Slack user seen
-- through two connections must remain ONE person.
--
-- So scope gets its own column, written only when the connector declares the
-- namespace connection-scoped. NULL means org-wide, which is every row that
-- exists today.
--
-- Deliberately NO foreign key, unlike the sibling `connection_id`
-- (`entity_identities_connection_id_fkey`, ON DELETE SET NULL). That column is
-- provenance, so nulling it on a deleted connection loses nothing. This one is
-- part of the uniqueness key: SET NULL would silently PROMOTE a
-- connection-scoped identity to org-wide — the exact collapse the column
-- prevents — and could collide with a legitimately org-wide row for the same
-- (org, namespace, identifier), aborting the connection delete on a unique
-- violation. CASCADE would delete identity rows, taking their entities'
-- attribution with them. Leaving the id dangling is inert instead: `connections.id`
-- is a bigserial and never reused, so the orphaned row simply stops matching.
ALTER TABLE entity_identities
  ADD COLUMN IF NOT EXISTS scope_connection_id bigint;

-- COALESCE to a sentinel rather than indexing the nullable column directly: in
-- a UNIQUE index NULLs are distinct, so a bare `scope_connection_id` would stop
-- deduplicating the org-wide rows entirely — every re-sync would insert another
-- copy. 0 is safe as the sentinel because `connections.id` is a bigserial and
-- never 0.
--
-- Existing rows all have NULL, so they collapse on exactly the key they
-- collapse on today: this migration is behaviour-preserving on its own, and
-- only a connector declaring `scope: 'connection'` changes any outcome.
DROP INDEX IF EXISTS idx_entity_identities_live_unique;

CREATE UNIQUE INDEX idx_entity_identities_live_unique
  ON entity_identities (organization_id, namespace, identifier, COALESCE(scope_connection_id, 0))
  WHERE deleted_at IS NULL;

-- migrate:down

-- Reversible only while no connection-scoped identities exist. Once two
-- connections hold the same (org, namespace, identifier) under different
-- scopes, restoring the narrower index makes them duplicates and the CREATE
-- fails — which is the correct failure: silently collapsing two different
-- tenants' customers onto one entity is the defect this column exists to
-- prevent, and the rollback must not perform it.
DROP INDEX IF EXISTS idx_entity_identities_live_unique;

CREATE UNIQUE INDEX idx_entity_identities_live_unique
  ON entity_identities (organization_id, namespace, identifier)
  WHERE deleted_at IS NULL;

ALTER TABLE entity_identities
  DROP COLUMN IF EXISTS scope_connection_id;
