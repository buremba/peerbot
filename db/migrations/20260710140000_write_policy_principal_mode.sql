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

-- Persist the ACTING MODE that queued a connector-action run, alongside the
-- trusted principal (runs.policy_principal_kind/id from 20260709150000). The
-- approve-time recheck must re-evaluate in the SAME mode it was queued under —
-- otherwise an autonomous run whose autonomous-only rule tightened to approval/deny
-- would be re-checked as ATTENDED (looser) and could sail through. Nullable +
-- additive: NULL means attended (the pre-mode default). Only autonomous runs write
-- 'autonomous', so no backfill is needed.
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS policy_principal_mode text NULL;
-- runs is hot/high-row-count: validate the CHECK in a second pass so the ADD takes
-- no scan/write lock (columns just added → every existing row is NULL and passes).
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_mode_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_policy_principal_mode_check CHECK (
    policy_principal_mode IS NULL OR policy_principal_mode IN ('autonomous')
  ) NOT VALID;
ALTER TABLE public.runs
  VALIDATE CONSTRAINT runs_policy_principal_mode_check;

-- Extend the uniqueness key so a (…, autonomous) override is a DISTINCT row from
-- the (…, both-mode) row for the same principal+scope. Without this, saving an
-- autonomous-only override would collide with the base row on the old key. Build
-- the new index first, then drop the old one, so the table is never left without
-- a uniqueness guarantee. COALESCE(principal_mode,'') keeps NULL rows unique.
--
-- ROLLING-DEPLOY NOTE (accepted risk, decided 2026-07-10): this runs as a
-- pre-upgrade Helm hook, so it completes BEFORE new pods roll. During the
-- RollingUpdate window (~30-90s) old pods run against the migrated schema with the
-- old mode-blind upsert/resolver. In theory a NULL-mode + autonomous row pair could
-- coexist and an old pod could apply the autonomous-only row to an attended write,
-- or its `IS NOT DISTINCT FROM` upsert could match both headers. We ACCEPT this: no
-- autonomous rows exist at cutover (the agent-envelope UI ships in THIS deploy), so
-- an autonomous row can only appear if an admin uses the brand-new UI during that
-- exact rollout window — effectively zero exposure. If the feature is ever
-- backported to a slow/large rollout, split this into expand (add index) + contract
-- (drop old index next deploy) and gate autonomous-row writes until the old index is
-- gone.
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

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_mode_check;
ALTER TABLE public.runs
  DROP COLUMN IF EXISTS policy_principal_mode;
