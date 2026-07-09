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

ALTER TABLE public.entity_approval_policies
  ADD CONSTRAINT entity_approval_policies_create_mode_check
    CHECK (create_mode IN ('auto', 'approval', 'deny', 'disabled')),
  ADD CONSTRAINT entity_approval_policies_update_mode_check
    CHECK (update_mode IN ('auto', 'approval', 'deny', 'disabled')),
  ADD CONSTRAINT entity_approval_policies_delete_mode_check
    CHECK (delete_mode IN ('auto', 'approval', 'deny', 'disabled'));

-- Lookup index for the generalized resolver (by class + principal). The existing
-- COALESCE scope unique index and org-lookup index stay untouched this phase.
-- squawk-ignore require-concurrent-index-creation -- additive; low row count, no hot-path contention on this table
CREATE INDEX IF NOT EXISTS entity_approval_policies_class_principal
  ON public.entity_approval_policies (organization_id, resource_class, principal_kind, principal_id);

-- migrate:down

DROP INDEX IF EXISTS public.entity_approval_policies_class_principal;

ALTER TABLE public.entity_approval_policies
  DROP CONSTRAINT IF EXISTS entity_approval_policies_create_mode_check,
  DROP CONSTRAINT IF EXISTS entity_approval_policies_update_mode_check,
  DROP CONSTRAINT IF EXISTS entity_approval_policies_delete_mode_check;

ALTER TABLE public.entity_approval_policies
  ADD CONSTRAINT entity_approval_policies_create_mode_check
    CHECK (create_mode IN ('auto', 'approval')),
  ADD CONSTRAINT entity_approval_policies_update_mode_check
    CHECK (update_mode IN ('auto', 'approval')),
  ADD CONSTRAINT entity_approval_policies_delete_mode_check
    CHECK (delete_mode IN ('auto', 'approval'));

ALTER TABLE public.entity_approval_policies
  DROP COLUMN IF EXISTS resource_class,
  DROP COLUMN IF EXISTS target_scope_kind,
  DROP COLUMN IF EXISTS target_scope_value,
  DROP COLUMN IF EXISTS predicate,
  DROP COLUMN IF EXISTS principal_kind,
  DROP COLUMN IF EXISTS principal_id;
