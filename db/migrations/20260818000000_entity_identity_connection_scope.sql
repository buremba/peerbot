-- migrate:up transaction:false

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
-- attribution with them. The dangling id is inert for matching; the entity
-- duplication that follows a reconnect is tracked separately (#2849).
--
-- Nullable with no default, so this is a metadata-only catalog update: no table
-- rewrite and no lingering ACCESS EXCLUSIVE hold.
ALTER TABLE entity_identities
  ADD COLUMN IF NOT EXISTS scope_connection_id bigint;

-- The replacement arbiter is built CONCURRENTLY under a NEW name and the old
-- one retired afterwards, so uniqueness is never absent and neither statement
-- takes ACCESS EXCLUSIVE for the duration of a build. The same name cannot be
-- reused while the old index still exists, and that is fine: `ON CONFLICT`
-- infers its arbiter by matching the target EXPRESSION against available
-- indexes, never by name.
--
-- COALESCE to a sentinel rather than indexing the nullable column directly: in
-- a UNIQUE index NULLs are distinct, so a bare `scope_connection_id` would stop
-- deduplicating the org-wide rows entirely — every re-sync would insert another
-- copy. 0 is safe as the sentinel because `connections.id` is a bigserial and
-- never 0.
--
-- Existing rows all have NULL, so they collapse on exactly the key they
-- collapse on today: this migration is behaviour-preserving on its own, and
-- only a connector declaring `scope: 'connection'` changes any outcome.
--
-- The INVALID-carcass heal is inlined rather than split into its own migration
-- so it re-runs on every retry: a crashed CONCURRENTLY build leaves an INVALID
-- same-named index, and `CREATE ... IF NOT EXISTS` would then silently no-op
-- over it and record this migration as applied with a NON-ENFORCING arbiter —
-- a silent uniqueness hole on identity claims. Same structure as
-- 20260721120020_connector_versions_org_unique.sql.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_entity_identities_live_unique_scoped'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entity_identities_live_unique_scoped';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_live_unique_scoped
  ON public.entity_identities (organization_id, namespace, identifier, COALESCE(scope_connection_id, 0))
  WHERE deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_live_unique;

-- migrate:down transaction:false

-- Reversible only while no connection-scoped identities exist. Once two
-- connections hold the same (org, namespace, identifier) under different
-- scopes, rebuilding the narrower arbiter makes them duplicates and the CREATE
-- fails — which is the correct failure: silently collapsing two different
-- tenants' customers onto one entity is the defect this column exists to
-- prevent, and the rollback must not perform it. A failed CONCURRENTLY build
-- leaves an INVALID carcass, healed on the next attempt by the block above.
DO $heal_down$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_entity_identities_live_unique'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entity_identities_live_unique';
  END IF;
END
$heal_down$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_live_unique
  ON public.entity_identities (organization_id, namespace, identifier)
  WHERE deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_live_unique_scoped;

ALTER TABLE entity_identities
  DROP COLUMN IF EXISTS scope_connection_id;
