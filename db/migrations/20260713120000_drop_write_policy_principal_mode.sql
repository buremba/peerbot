-- migrate:up
--
-- Retire attended/autonomous dual-mode on write policies. One envelope for
-- chat and watchers. Table is small admin config (not events-scale).
-- Cost: O(rows of write_approval_policies) — typically tens per org.
--
-- CRITICAL: autonomous-only rows may be STRICTER than the mode-neutral row
-- for the same scope. Deleting them outright would LOOSEN the effective
-- policy. Fold each autonomous effect into the mode-neutral envelope first
-- (most-restrictive wins), then drop the autonomous headers.

-- Restrictiveness order: deny > disabled > approval > auto
-- (deny and disabled both stop the write; prefer deny when both appear).
WITH auto_effects AS (
  SELECT
    p.organization_id,
    p.resource_class,
    p.principal_kind,
    p.principal_id,
    p.operation_key,
    p.entity_type_slug,
    p.field_path,
    p.entity_id,
    e.action,
    e.effect AS auto_effect
  FROM write_approval_policies p
  JOIN write_policy_action_effects e ON e.policy_id = p.id
  WHERE p.principal_mode IS NOT NULL
),
neutral AS (
  SELECT
    p.id AS policy_id,
    p.organization_id,
    p.resource_class,
    p.principal_kind,
    p.principal_id,
    p.operation_key,
    p.entity_type_slug,
    p.field_path,
    p.entity_id
  FROM write_approval_policies p
  WHERE p.principal_mode IS NULL
),
-- Ensure a mode-neutral header exists for every autonomous scope (so we have
-- somewhere to fold effects into).
inserted AS (
  INSERT INTO write_approval_policies (
    organization_id, resource_class, principal_kind, principal_id,
    operation_key, entity_type_slug, field_path, entity_id,
    created_at, updated_at
  )
  SELECT DISTINCT
    a.organization_id, a.resource_class, a.principal_kind, a.principal_id,
    a.operation_key, a.entity_type_slug, a.field_path, a.entity_id,
    now(), now()
  FROM auto_effects a
  WHERE NOT EXISTS (
    SELECT 1 FROM write_approval_policies n
    WHERE n.organization_id = a.organization_id
      AND n.resource_class = a.resource_class
      AND n.principal_kind IS NOT DISTINCT FROM a.principal_kind
      AND n.principal_id IS NOT DISTINCT FROM a.principal_id
      AND n.principal_mode IS NULL
      AND n.operation_key IS NOT DISTINCT FROM a.operation_key
      AND n.entity_type_slug IS NOT DISTINCT FROM a.entity_type_slug
      AND n.field_path IS NOT DISTINCT FROM a.field_path
      AND n.entity_id IS NOT DISTINCT FROM a.entity_id
  )
  ON CONFLICT DO NOTHING
  RETURNING id
),
neutral_after AS (
  SELECT
    p.id AS policy_id,
    p.organization_id,
    p.resource_class,
    p.principal_kind,
    p.principal_id,
    p.operation_key,
    p.entity_type_slug,
    p.field_path,
    p.entity_id
  FROM write_approval_policies p
  WHERE p.principal_mode IS NULL
),
merged AS (
  SELECT
    n.policy_id,
    a.action,
    a.auto_effect,
    e.effect AS neutral_effect
  FROM auto_effects a
  JOIN neutral_after n
    ON n.organization_id = a.organization_id
   AND n.resource_class = a.resource_class
   AND n.principal_kind IS NOT DISTINCT FROM a.principal_kind
   AND n.principal_id IS NOT DISTINCT FROM a.principal_id
   AND n.operation_key IS NOT DISTINCT FROM a.operation_key
   AND n.entity_type_slug IS NOT DISTINCT FROM a.entity_type_slug
   AND n.field_path IS NOT DISTINCT FROM a.field_path
   AND n.entity_id IS NOT DISTINCT FROM a.entity_id
  LEFT JOIN write_policy_action_effects e
    ON e.policy_id = n.policy_id AND e.action = a.action
),
-- Rank: deny=3, disabled=2, approval=1, auto=0; pick the max rank.
picked AS (
  SELECT
    policy_id,
    action,
    CASE
      WHEN auto_effect = 'deny' OR neutral_effect = 'deny' THEN 'deny'
      WHEN auto_effect = 'disabled' OR neutral_effect = 'disabled' THEN 'disabled'
      WHEN auto_effect = 'approval' OR neutral_effect = 'approval' THEN 'approval'
      ELSE COALESCE(auto_effect, neutral_effect, 'auto')
    END AS effect
  FROM merged
)
INSERT INTO write_policy_action_effects (policy_id, action, effect)
SELECT policy_id, action, effect FROM picked
ON CONFLICT (policy_id, action) DO UPDATE
  SET effect = EXCLUDED.effect
  WHERE write_policy_action_effects.effect IS DISTINCT FROM EXCLUDED.effect
    -- Only tighten: never loosen an existing neutral effect toward auto.
    AND (
      CASE EXCLUDED.effect
        WHEN 'deny' THEN 3
        WHEN 'disabled' THEN 2
        WHEN 'approval' THEN 1
        ELSE 0
      END
      >
      CASE write_policy_action_effects.effect
        WHEN 'deny' THEN 3
        WHEN 'disabled' THEN 2
        WHEN 'approval' THEN 1
        ELSE 0
      END
    );

-- Autonomous headers (and their child effects via CASCADE) are now redundant.
DELETE FROM write_approval_policies WHERE principal_mode IS NOT NULL;

-- squawk-ignore require-concurrent-index-deletion -- low-row-count policy table; brief lock negligible at this scale
DROP INDEX IF EXISTS write_approval_policies_class_principal_mode_op_scope_key;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_principal_mode_check;

ALTER TABLE write_approval_policies
  DROP COLUMN IF EXISTS principal_mode;

-- Unique identity without principal_mode.
-- squawk-ignore require-concurrent-index-creation -- low-row-count policy table; brief lock negligible at this scale
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_class_principal_op_scope_key
  ON write_approval_policies (
    organization_id,
    resource_class,
    COALESCE(principal_kind, ''),
    COALESCE(principal_id, ''),
    COALESCE(operation_key, ''),
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, ''),
    COALESCE(entity_id, 0)
  );

-- migrate:down
ALTER TABLE write_approval_policies
  ADD COLUMN IF NOT EXISTS principal_mode text;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_principal_mode_check;

ALTER TABLE write_approval_policies
  ADD CONSTRAINT write_approval_policies_principal_mode_check
  CHECK (principal_mode IS NULL OR principal_mode = 'autonomous') NOT VALID;
-- squawk-ignore prefer-robust-stmts -- rollback path; low row count
ALTER TABLE write_approval_policies
  VALIDATE CONSTRAINT write_approval_policies_principal_mode_check;

-- squawk-ignore require-concurrent-index-deletion -- rollback path; brief lock negligible at this scale
DROP INDEX IF EXISTS write_approval_policies_class_principal_op_scope_key;

-- squawk-ignore require-concurrent-index-creation -- rollback path; low row count
CREATE UNIQUE INDEX IF NOT EXISTS write_approval_policies_class_principal_mode_op_scope_key
  ON write_approval_policies (
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
