-- migrate:up

-- v1.1 write-gate model: replace the three positional mode columns
-- (create_mode/update_mode/delete_mode) on write_approval_policies with an
-- (action, effect) child table. The parent row is now a pure scope+principal+
-- delivery HEADER; each governed action gets its own child row. This ends the
-- connector_action cram (its single `execute` verb was forced onto create_mode)
-- and lets a new resource class declare its own action vocabulary in code
-- (write-action-manifest.ts) without a positional-column change.
--
-- DEPLOY NOTE: this is a one-shot cut-over, not expand/contract. dbmate runs in
-- the Helm pre-upgrade Job BEFORE the new pods roll, and the two old replicas
-- keep querying create_mode/update_mode/delete_mode until they're replaced — so
-- write-gate resolution 500s for the ~30-90s rollout overlap, then recovers once
-- the new pods (which read the child table) are live. This blip is accepted, the
-- same tradeoff taken by the #1827 bare-rename migration; downtime here is
-- acceptable and buys a clean end state with no lingering legacy columns.

-- ── Preflight ────────────────────────────────────────────────────────────────
-- The target_scope_kind/target_scope_value/predicate columns were added in the
-- M1a expand migration but never read by any code. We drop them below; assert
-- first that nobody populated them via manual SQL, so a real (if unwired) value
-- can't be silently discarded.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.write_approval_policies
    WHERE target_scope_kind IS NOT NULL
       OR target_scope_value IS NOT NULL
       OR predicate IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'write_approval_policies has non-NULL target_scope_kind/target_scope_value/predicate; refusing to drop populated columns';
  END IF;
END $$;

-- ── Child table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.write_policy_action_effects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy_id bigint NOT NULL
    REFERENCES public.write_approval_policies(id) ON DELETE CASCADE,
  -- Action/effect domains mirror write-action-manifest.ts. Per-class action
  -- legality (e.g. connector_action only governs `execute`) is enforced by the
  -- backfill below + the app-side manifest validators + the resolver's
  -- fail-closed on undeclared tuples; a table CHECK can't cheaply join the
  -- parent's resource_class, and the connector-only `disabled` rule already
  -- lives as a parent CHECK (write_approval_policies_disabled_only_connector).
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'execute')),
  effect text NOT NULL CHECK (effect IN ('auto', 'approval', 'deny', 'disabled'))
);

-- One effect per (policy, action). The resolver reads the requested action's
-- effect; a scope declaring no row for an action inherits the class default.
-- squawk-ignore require-concurrent-index-creation -- table created just above; no traffic to block
CREATE UNIQUE INDEX IF NOT EXISTS write_policy_action_effects_policy_action_key
  ON public.write_policy_action_effects (policy_id, action);

-- ── Class-aware backfill ─────────────────────────────────────────────────────
-- entity + agent_config: three rows (create/update/delete from their columns).
-- Skip an effect that is illegal for the class per the manifest — none exist in
-- practice (entity/agent_config only ever held auto/approval/deny), but the
-- filter keeps the backfill honest if a manual row snuck in a bad value.
INSERT INTO public.write_policy_action_effects (policy_id, action, effect)
SELECT p.id, v.action, v.effect
FROM public.write_approval_policies p
CROSS JOIN LATERAL (
  VALUES
    ('create', p.create_mode),
    ('update', p.update_mode),
    ('delete', p.delete_mode)
) AS v(action, effect)
WHERE p.resource_class IN ('entity', 'agent_config')
  AND v.effect IN ('auto', 'approval', 'deny');

-- connector_action: EXACTLY ONE `execute` row, sourced from create_mode (the
-- column the old resolver crammed the execute decision into). Exploding these
-- into create/update/delete would leave connector_action with no `execute`
-- policy, silently dropping existing approve/deny rows to the execute=auto
-- default — a security regression. So map create_mode → execute, one row.
INSERT INTO public.write_policy_action_effects (policy_id, action, effect)
SELECT p.id, 'execute', p.create_mode
FROM public.write_approval_policies p
WHERE p.resource_class = 'connector_action'
  AND p.create_mode IN ('auto', 'approval', 'deny', 'disabled');

-- ── Drop the legacy columns ──────────────────────────────────────────────────
-- The mode columns are replaced by the child table; the target_scope_*/predicate
-- columns were dead (asserted NULL above). All readers move to the new model in
-- the same deploy.
ALTER TABLE public.write_approval_policies
  DROP COLUMN IF EXISTS create_mode,
  DROP COLUMN IF EXISTS update_mode,
  DROP COLUMN IF EXISTS delete_mode,
  DROP COLUMN IF EXISTS target_scope_kind,
  DROP COLUMN IF EXISTS target_scope_value,
  DROP COLUMN IF EXISTS predicate;

-- migrate:down

-- Restore the mode columns (nullable first so the fold-back can populate them),
-- then reconstruct create/update/delete_mode from the child rows and drop the
-- child table. Reversible for the four actions this build knows; a child row
-- with an action the down-path doesn't map (none today) would be dropped.
ALTER TABLE public.write_approval_policies
  ADD COLUMN IF NOT EXISTS create_mode text,
  ADD COLUMN IF NOT EXISTS update_mode text,
  ADD COLUMN IF NOT EXISTS delete_mode text,
  ADD COLUMN IF NOT EXISTS target_scope_kind text,
  ADD COLUMN IF NOT EXISTS target_scope_value text,
  ADD COLUMN IF NOT EXISTS predicate jsonb;

-- entity/agent_config: fold each action back to its column.
-- squawk-ignore prefer-robust-stmts -- rollback path; single-shot fold-back, not a re-runnable forward migration
UPDATE public.write_approval_policies p SET
  create_mode = COALESCE((SELECT e.effect FROM public.write_policy_action_effects e WHERE e.policy_id = p.id AND e.action = 'create'), 'auto'),
  update_mode = COALESCE((SELECT e.effect FROM public.write_policy_action_effects e WHERE e.policy_id = p.id AND e.action = 'update'), 'auto'),
  delete_mode = COALESCE((SELECT e.effect FROM public.write_policy_action_effects e WHERE e.policy_id = p.id AND e.action = 'delete'), 'approval')
WHERE p.resource_class IN ('entity', 'agent_config');

-- connector_action: fold the execute row back into create_mode (the old cram),
-- leave update/delete at the historical defaults.
-- squawk-ignore prefer-robust-stmts -- rollback path; single-shot fold-back
UPDATE public.write_approval_policies p SET
  create_mode = COALESCE((SELECT e.effect FROM public.write_policy_action_effects e WHERE e.policy_id = p.id AND e.action = 'execute'), 'auto'),
  update_mode = 'auto',
  delete_mode = 'approval'
WHERE p.resource_class = 'connector_action';

-- rollback path; restore the historical defaults. Kept on one line so the
-- ignore directive below anchors to this statement.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE public.write_approval_policies ALTER COLUMN create_mode SET DEFAULT 'auto', ALTER COLUMN update_mode SET DEFAULT 'auto', ALTER COLUMN delete_mode SET DEFAULT 'approval';
-- rollback path; the UPDATEs above populate every row before SET NOT NULL, so no
-- row is ever null when the constraint applies.
-- squawk-ignore prefer-robust-stmts,adding-not-nullable-field
ALTER TABLE public.write_approval_policies ALTER COLUMN create_mode SET NOT NULL, ALTER COLUMN update_mode SET NOT NULL, ALTER COLUMN delete_mode SET NOT NULL;

-- squawk-ignore ban-drop-table -- down for the child table this migration introduces
DROP TABLE IF EXISTS public.write_policy_action_effects;
