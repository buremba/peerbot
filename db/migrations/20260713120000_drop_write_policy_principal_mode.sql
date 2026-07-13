-- migrate:up
--
-- Retire attended/autonomous dual-mode on write policies. One envelope for
-- chat and watchers. Table is small admin config (not events-scale).
-- Cost: O(rows of write_approval_policies) — typically tens per org.

-- Drop legacy autonomous-only rows (and their effect children via CASCADE
-- would need policy delete first for the child FK; delete effects then headers).
DELETE FROM write_policy_action_effects
 WHERE policy_id IN (
   SELECT id FROM write_approval_policies WHERE principal_mode IS NOT NULL
 );

DELETE FROM write_approval_policies WHERE principal_mode IS NOT NULL;

DROP INDEX IF EXISTS write_approval_policies_class_principal_mode_op_scope_key;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_principal_mode_check;

ALTER TABLE write_approval_policies
  DROP COLUMN IF EXISTS principal_mode;

-- Unique identity without principal_mode.
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
  CHECK (principal_mode IS NULL OR principal_mode = 'autonomous');

DROP INDEX IF EXISTS write_approval_policies_class_principal_op_scope_key;

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
