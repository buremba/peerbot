-- migrate:up

-- Per-operation connector scope. Until now `connector_action` policy rows carried
-- a single blanket `execute` effect governing EVERY operation a connection exposes
-- (send a Slack message, place a Deliveroo order, delete a Linear issue — all one
-- toggle). This adds an `operation_key` scope dimension so an agent can carry a
-- stricter rule for a specific operation (e.g. `deliveroo.place_order` = approval)
-- while the blanket `execute` stays auto for the rest.
--
-- Mirrors how `entity_id`/`field_path` already extend entity scope with their own
-- columns: a row with operation_key set is MORE SPECIFIC than the blanket
-- (operation_key IS NULL) row and outranks it in the resolver's scope fold. NULL is
-- the blanket row — every existing row keeps applying to all operations, so old pods
-- (whose INSERTs don't name operation_key) still write valid blanket rows.
ALTER TABLE public.write_approval_policies
  ADD COLUMN IF NOT EXISTS operation_key text NULL;

-- Extend the uniqueness key so a (…, operation_key) row is DISTINCT from the
-- (…, blanket) row for the same principal+class. Build the new index first, then drop
-- the old one, so the table is never left without a uniqueness guarantee.
-- COALESCE(operation_key,'') keeps blanket (NULL) rows unique.
--
-- DEPLOY SAFETY: additive column + expand-before-contract index. Old pods write the
-- blanket rule with a scope-BLIND UPDATE/DELETE (their WHERE has no operation_key
-- clause), so on the migrated schema an old pod could match BOTH the blanket row AND
-- a new per-op row in one statement and clobber the per-op effect — a PERSISTENT
-- fail-open, not the self-healing "old pod can't see the row" kind. This is closed at
-- the deploy layer, NOT here: the app Deployment is `strategy: Recreate` with
-- replicaCount 1 (charts/lobu/values.yaml), so the old pod fully terminates before
-- the new one starts and no two server versions ever serve writes concurrently. If
-- this is ever backported to a multi-replica RollingUpdate, split into expand (this
-- migration) + a NEXT-release feature that gates operation_key writes until every pod
-- carries the scope-aware predicate. No backfill — every existing row is a blanket
-- row and stays one.
-- squawk-ignore require-concurrent-index-creation -- low-row-count policy table; brief lock negligible at this scale
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_class_principal_mode_op_scope_key
  ON public.write_approval_policies (
    organization_id,
    resource_class,
    COALESCE(principal_kind, ''),
    COALESCE(principal_id, ''),
    COALESCE(principal_mode, ''),
    COALESCE(operation_key, ''),
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, ''),
    COALESCE(entity_id, 0)
  );

-- squawk-ignore require-concurrent-index-deletion -- low-row-count policy table; brief lock negligible at this scale
DROP INDEX IF EXISTS public.write_approval_policies_class_principal_mode_scope_key;

-- migrate:down

-- Restore the op-less unique key before dropping the op-aware one, so the table
-- always has a uniqueness guarantee. Safe only because a rollback also drops the
-- operation_key column below (any op-specific rows would otherwise collide with their
-- blanket row on the narrower key) — so drop such rows first.
DELETE FROM public.write_approval_policies WHERE operation_key IS NOT NULL;

-- squawk-ignore require-concurrent-index-creation -- rollback path; low row count
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_class_principal_mode_scope_key
  ON public.write_approval_policies (
    organization_id,
    resource_class,
    COALESCE(principal_kind, ''),
    COALESCE(principal_id, ''),
    COALESCE(principal_mode, ''),
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, ''),
    COALESCE(entity_id, 0)
  );

-- squawk-ignore require-concurrent-index-deletion -- rollback path; brief lock negligible at this scale
DROP INDEX IF EXISTS public.write_approval_policies_class_principal_mode_op_scope_key;

ALTER TABLE public.write_approval_policies
  DROP COLUMN IF EXISTS operation_key;
