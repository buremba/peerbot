-- migrate:up

-- Add the acting-mode dimension to a write policy. A row with principal_mode
-- 'autonomous' applies only to autonomous (watcher / scheduled) runs; NULL means
-- the row applies to BOTH attended and autonomous. This lets an agent's watcher
-- (its autonomous self) carry a stricter envelope than the same agent acting
-- attended — the resolver evaluates autonomous as at-least-as-strict as attended.
--
-- NULL default is backward-compatible: every existing row keeps applying to both
-- modes, so old pods (whose INSERTs don't name principal_mode) still write valid
-- both-mode rows.
ALTER TABLE public.write_approval_policies
  ADD COLUMN IF NOT EXISTS principal_mode text NULL
    CHECK (principal_mode IS NULL OR principal_mode IN ('autonomous'));

-- Extend the uniqueness key so a (…, autonomous) override is a DISTINCT row from
-- the (…, both-mode) row for the same principal+scope. Without this, saving an
-- autonomous-only override would collide with the base row on the old key. Build
-- the new index first, then drop the old one, so the table is never left without
-- a uniqueness guarantee. COALESCE(principal_mode,'') keeps NULL rows unique.
-- squawk-ignore require-concurrent-index-creation -- low-row-count policy table; brief lock negligible at this scale
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

-- squawk-ignore require-concurrent-index-deletion -- low-row-count policy table; brief lock negligible at this scale
DROP INDEX IF EXISTS public.write_approval_policies_class_principal_scope_key;

-- migrate:down

-- Restore the mode-less unique key before dropping the mode-aware one, so the
-- table always has a uniqueness guarantee. Safe only because a rollback also drops
-- the principal_mode column below (any autonomous-only rows would otherwise collide
-- with their base row on the narrower key) — so drop such rows first.
DELETE FROM public.write_approval_policies WHERE principal_mode IS NOT NULL;

-- squawk-ignore require-concurrent-index-creation -- rollback path; low row count
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_class_principal_scope_key
  ON public.write_approval_policies (
    organization_id,
    resource_class,
    COALESCE(principal_kind, ''),
    COALESCE(principal_id, ''),
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, ''),
    COALESCE(entity_id, 0)
  );

-- squawk-ignore require-concurrent-index-deletion -- rollback path; brief lock negligible at this scale
DROP INDEX IF EXISTS public.write_approval_policies_class_principal_mode_scope_key;

ALTER TABLE public.write_approval_policies
  DROP COLUMN IF EXISTS principal_mode;
