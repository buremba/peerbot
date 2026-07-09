-- migrate:up

-- M1a (expand phase, deploy-safe): add the generalized write-gate policy columns
-- to the EXISTING entity_approval_policies table. NO rename, NO column drop — the
-- table is renamed to write_approval_policies only in the post-rollout contract
-- migration (see docs/plans/write-gate-generalization.md §6e.1), because dbmate
-- runs in a Helm pre-upgrade hook BEFORE new pods roll out, so old pods must keep
-- reading the current table name and columns for the whole rollout window.
--
-- All new columns are nullable or defaulted so old-code INSERTs (which don't name
-- them) still succeed. resource_class defaults to 'entity' — the only class today.

-- squawk-ignore prefer-text-field -- matches existing varchar-free style on this table
ALTER TABLE public.entity_approval_policies
  ADD COLUMN IF NOT EXISTS resource_class text NOT NULL DEFAULT 'entity',
  ADD COLUMN IF NOT EXISTS target_scope_kind text NULL,
  ADD COLUMN IF NOT EXISTS target_scope_value text NULL,
  ADD COLUMN IF NOT EXISTS predicate jsonb NULL,
  ADD COLUMN IF NOT EXISTS principal_kind text NULL,
  ADD COLUMN IF NOT EXISTS principal_id text NULL;

-- Widen the per-action mode CHECKs to admit 'deny' (role/policy floor) and
-- 'disabled' (connector-action off-switch). The resolver understands 'deny' as of
-- the cutover commit; until then the API mode validator is the only writer, so no
-- 'deny' row can exist before the resolver handles it (see §6f R5).
ALTER TABLE public.entity_approval_policies
  DROP CONSTRAINT IF EXISTS entity_approval_policies_create_mode_check,
  DROP CONSTRAINT IF EXISTS entity_approval_policies_update_mode_check,
  DROP CONSTRAINT IF EXISTS entity_approval_policies_delete_mode_check;

-- Add NOT VALID first (no table scan, no write lock), then VALIDATE in a second
-- pass (SHARE UPDATE EXCLUSIVE — concurrent reads/writes proceed). The pre-existing
-- rows only hold 'auto'/'approval', which the widened set is a superset of, so the
-- validate is guaranteed to pass; splitting it just avoids the blocking scan.
ALTER TABLE public.entity_approval_policies
  ADD CONSTRAINT entity_approval_policies_create_mode_check
    CHECK (create_mode IN ('auto', 'approval', 'deny', 'disabled')) NOT VALID,
  ADD CONSTRAINT entity_approval_policies_update_mode_check
    CHECK (update_mode IN ('auto', 'approval', 'deny', 'disabled')) NOT VALID,
  ADD CONSTRAINT entity_approval_policies_delete_mode_check
    CHECK (delete_mode IN ('auto', 'approval', 'deny', 'disabled')) NOT VALID;

ALTER TABLE public.entity_approval_policies
  VALIDATE CONSTRAINT entity_approval_policies_create_mode_check;
ALTER TABLE public.entity_approval_policies
  VALIDATE CONSTRAINT entity_approval_policies_update_mode_check;
ALTER TABLE public.entity_approval_policies
  VALIDATE CONSTRAINT entity_approval_policies_delete_mode_check;

-- Lookup index for the generalized resolver (by class + principal).
-- squawk-ignore require-concurrent-index-creation -- additive; low row count, no hot-path contention on this table
CREATE INDEX IF NOT EXISTS entity_approval_policies_class_principal
  ON public.entity_approval_policies (organization_id, resource_class, principal_kind, principal_id);

-- Generalized uniqueness key: one policy row per (org, class, principal, scope).
-- Superset of the old entity_approval_policies_scope_key — for the pre-existing
-- rows (all resource_class='entity', principal_kind NULL) this key equals the old
-- key extended with constants, so it introduces no collision. The upsert's
-- ON CONFLICT targets this index by its column list. The old scope-only index is
-- dropped: old pods only INSERT entity/any-principal rows (their INSERTs don't
-- name the new columns, so the defaults apply), which this index still constrains.
-- squawk-ignore require-concurrent-index-creation -- low row count, no hot-path contention on this table
CREATE UNIQUE INDEX IF NOT EXISTS entity_approval_policies_class_principal_scope_key
  ON public.entity_approval_policies (
    organization_id,
    resource_class,
    COALESCE(principal_kind, ''),
    COALESCE(principal_id, ''),
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, ''),
    COALESCE(entity_id, 0)
  );

-- squawk-ignore require-concurrent-index-deletion -- low-row-count policy table, no hot-path contention; a bare DROP takes a brief ACCESS EXCLUSIVE lock that is negligible at this table's scale
DROP INDEX IF EXISTS public.entity_approval_policies_scope_key;

-- migrate:down

-- Restore the original scope-only unique index before dropping the generalized one,
-- so the table is never left without a uniqueness guarantee mid-rollback.
-- squawk-ignore require-concurrent-index-creation -- rollback path; low row count
CREATE UNIQUE INDEX IF NOT EXISTS entity_approval_policies_scope_key
  ON public.entity_approval_policies (
    organization_id,
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, ''),
    COALESCE(entity_id, 0)
  );

-- squawk-ignore require-concurrent-index-deletion -- rollback path; low-row-count policy table, brief lock negligible at this scale
DROP INDEX IF EXISTS public.entity_approval_policies_class_principal_scope_key;
-- squawk-ignore require-concurrent-index-deletion -- rollback path; low-row-count policy table, brief lock negligible at this scale
DROP INDEX IF EXISTS public.entity_approval_policies_class_principal;

ALTER TABLE public.entity_approval_policies
  DROP CONSTRAINT IF EXISTS entity_approval_policies_create_mode_check,
  DROP CONSTRAINT IF EXISTS entity_approval_policies_update_mode_check,
  DROP CONSTRAINT IF EXISTS entity_approval_policies_delete_mode_check;

ALTER TABLE public.entity_approval_policies
  ADD CONSTRAINT entity_approval_policies_create_mode_check
    CHECK (create_mode IN ('auto', 'approval')) NOT VALID,
  ADD CONSTRAINT entity_approval_policies_update_mode_check
    CHECK (update_mode IN ('auto', 'approval')) NOT VALID,
  ADD CONSTRAINT entity_approval_policies_delete_mode_check
    CHECK (delete_mode IN ('auto', 'approval')) NOT VALID;

ALTER TABLE public.entity_approval_policies
  VALIDATE CONSTRAINT entity_approval_policies_create_mode_check;
ALTER TABLE public.entity_approval_policies
  VALIDATE CONSTRAINT entity_approval_policies_update_mode_check;
ALTER TABLE public.entity_approval_policies
  VALIDATE CONSTRAINT entity_approval_policies_delete_mode_check;

ALTER TABLE public.entity_approval_policies
  DROP COLUMN IF EXISTS resource_class,
  DROP COLUMN IF EXISTS target_scope_kind,
  DROP COLUMN IF EXISTS target_scope_value,
  DROP COLUMN IF EXISTS predicate,
  DROP COLUMN IF EXISTS principal_kind,
  DROP COLUMN IF EXISTS principal_id;
