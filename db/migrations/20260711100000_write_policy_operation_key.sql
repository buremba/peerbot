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
-- ROLLING-DEPLOY: additive column + expand-before-contract index. Old pods keep
-- writing operation_key=NULL blanket rows (valid under the new key); the new
-- per-operation UI is the only writer of non-NULL operation_key rows and ships in
-- this deploy, so a non-blanket row can only appear once new pods are live. No
-- backfill — every existing row is a blanket row and stays one.
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
