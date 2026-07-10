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
-- would be re-checked as ATTENDED (looser) and could sail through.
--
-- BOTH modes are written EXPLICITLY ('attended' | 'autonomous') so the recheck can
-- trust the stored value. NULL is reserved for LEGACY rows queued before this column
-- existed — the recheck can't know their true mode, so it fails closed to autonomous
-- for those (the safe direction). Writing 'attended' explicitly (rather than leaving
-- new attended runs NULL) is what lets the recheck NOT over-deny a genuine attended
-- run that merely queued because its connection requires approval. Additive + no
-- backfill: legacy rows stay NULL and are handled by the fail-closed fallback.
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS policy_principal_mode text NULL;
-- runs is hot/high-row-count: validate the CHECK in a second pass so the ADD takes
-- no scan/write lock (columns just added → every existing row is NULL and passes).
ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_mode_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_policy_principal_mode_check CHECK (
    policy_principal_mode IS NULL OR policy_principal_mode IN ('attended', 'autonomous')
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

-- Cascade an agent's write-gate policy rows when the agent is deleted. `principal_id`
-- is a POLYMORPHIC text column (agent id / `watcher:<id>` / NULL), so a plain FK
-- can't express this — a trigger enforces it in the DB, covering EVERY deletion path
-- (the manage_agents tool, the dashboard's configStore.deleteMetadata, and any
-- future one). Agent ids are reusable slugs, so leaving these rows would let a later
-- agent recreated with the same id silently inherit the old envelope. Child
-- write_policy_action_effects rows cascade via their policy_id FK.
CREATE OR REPLACE FUNCTION public.cascade_delete_agent_write_policies()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.write_approval_policies
  WHERE organization_id = OLD.organization_id
    AND principal_kind = 'agent'
    AND principal_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_delete_agent_write_policies ON public.agents;
CREATE TRIGGER trg_cascade_delete_agent_write_policies
  AFTER DELETE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.cascade_delete_agent_write_policies();

-- Reject an agent-principal policy write whose agent doesn't exist, and SERIALIZE it
-- against a concurrent agent delete. The app checks agent existence and inserts the
-- policy in SEPARATE transactions, so without this a PUT that observed agent A could
-- commit its INSERT *after* A's delete trigger already cascaded — leaving an orphan
-- row that a later agent recreated with the reusable A slug would silently inherit
-- (defeating the cascade above). The `FOR KEY SHARE` lock on the agent row is the
-- serialization point: if the delete holds the row, this INSERT blocks then sees zero
-- rows and raises; if this INSERT holds the KEY SHARE lock, the delete's FOR UPDATE
-- (row removal) blocks until we commit, then the AFTER DELETE trigger cascades our
-- freshly-inserted row. Only EXACT agent-principal rows are checked (principal_id is
-- polymorphic: agent id / `watcher:<id>` / NULL) — watcher/kind-wide/null rows have no
-- single agent to bind and are left alone.
-- Remediate rows already orphaned before this deploy. Per-agent policy rows were
-- creatable on main (write-gate v1 + the per-principal PUT) with NO cascade on agent
-- delete, so any agent deleted under old code left dangling `principal_kind='agent'`
-- rows. The cascade (above) only fires on FUTURE deletes and the assert trigger
-- (below) only blocks FUTURE inserts — neither remediates the historical window. An
-- orphan `execute=auto`/`update=auto` row keyed to a reusable slug would be inherited
-- by the next agent created with that id (the exact slug-inheritance hole this
-- migration closes), and once the assert trigger is live such rows are frozen (any
-- UPDATE trips it). Delete them now, one-time, before arming the trigger. Child
-- write_policy_action_effects rows cascade via their policy_id FK.
DELETE FROM public.write_approval_policies p
WHERE p.principal_kind = 'agent'
  AND p.principal_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.agents a
    WHERE a.id = p.principal_id AND a.organization_id = p.organization_id
  );

CREATE OR REPLACE FUNCTION public.assert_agent_write_policy_principal_exists()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_kind = 'agent' AND NEW.principal_id IS NOT NULL THEN
    PERFORM 1 FROM public.agents
    WHERE id = NEW.principal_id
      AND organization_id = NEW.organization_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'write_approval_policies principal agent % not found in org %',
        NEW.principal_id, NEW.organization_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Fire on INSERT and only on an UPDATE that REBINDS the principal — never on an
-- effect-only header UPDATE (delivery target, updated_at). The upsert's UPDATE arm
-- keeps principal_kind/principal_id/organization_id fixed (they're its match key), so
-- restricting the columns is integrity-preserving. It also avoids a lock-order
-- deadlock: an effect-only UPDATE first locks the policy row then would take FOR KEY
-- SHARE on the agent, while a concurrent agent DELETE locks the agent then cascades
-- to the policy row — a circular wait (40P01). Scoping the trigger off the header-only
-- arm removes that inversion; the INSERT/rebind arms still serialize correctly (they
-- take the agent lock first).
DROP TRIGGER IF EXISTS trg_assert_agent_write_policy_principal_exists ON public.write_approval_policies;
CREATE TRIGGER trg_assert_agent_write_policy_principal_exists
  BEFORE INSERT OR UPDATE OF principal_kind, principal_id, organization_id
  ON public.write_approval_policies
  FOR EACH ROW EXECUTE FUNCTION public.assert_agent_write_policy_principal_exists();

-- migrate:down

DROP TRIGGER IF EXISTS trg_assert_agent_write_policy_principal_exists ON public.write_approval_policies;
DROP FUNCTION IF EXISTS public.assert_agent_write_policy_principal_exists();

DROP TRIGGER IF EXISTS trg_cascade_delete_agent_write_policies ON public.agents;
DROP FUNCTION IF EXISTS public.cascade_delete_agent_write_policies();

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
