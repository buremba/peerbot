-- migrate:up
--
-- Clarify write_approval_policies as:
--   WHO acts     → principal_kind / principal_id
--                  (both NULL = org default; agent + id = that agent's envelope)
--   WHAT class   → resource_class (entity | agent_config | connector_action)
--   EXCEPTION    → at most one class-specific scope column:
--                  entity_type_slug | operation_key | target_agent_id
--   EFFECTS      → child table write_policy_action_effects (action → effect)
--
-- Adds target_agent_id so agent_config can exception "update/delete agent X"
-- without opening all agent writes.

ALTER TABLE write_approval_policies
  ADD COLUMN IF NOT EXISTS target_agent_id text;

COMMENT ON TABLE write_approval_policies IS
  'Write-gate policy: org defaults (principal NULL) + per-agent envelopes + sparse exceptions. Effects live in write_policy_action_effects.';

COMMENT ON COLUMN write_approval_policies.resource_class IS
  'entity | agent_config | connector_action';

COMMENT ON COLUMN write_approval_policies.principal_kind IS
  'NULL = org default. agent | watcher = envelope for that principal kind.';

COMMENT ON COLUMN write_approval_policies.principal_id IS
  'NULL with kind set = any of that kind; set = specific agent/watcher id. Both principal columns NULL = org default.';

COMMENT ON COLUMN write_approval_policies.entity_type_slug IS
  'entity exception: type slug. NULL = all types for this principal.';

COMMENT ON COLUMN write_approval_policies.operation_key IS
  'connector_action exception: qualified connector_key::op. NULL = all write ops.';

COMMENT ON COLUMN write_approval_policies.target_agent_id IS
  'agent_config exception: agents.id being updated/deleted. NULL = any target. create always uses the blanket row.';

COMMENT ON COLUMN write_approval_policies.field_path IS
  'entity finer scope (field); not used on the agent Permissions matrix.';

COMMENT ON COLUMN write_approval_policies.entity_id IS
  'entity finer scope (single row); not used on the agent Permissions matrix.';

-- Class ↔ scope consistency (specialized columns only legal on their class).
ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_scope_class_check;

ALTER TABLE write_approval_policies
  ADD CONSTRAINT write_approval_policies_scope_class_check CHECK (
    (operation_key IS NULL OR resource_class = 'connector_action')
    AND (target_agent_id IS NULL OR resource_class = 'agent_config')
    AND (
      (entity_type_slug IS NULL AND field_path IS NULL AND entity_id IS NULL)
      OR resource_class = 'entity'
    )
  );

-- Rebuild unique identity to include target_agent_id.
DROP INDEX IF EXISTS write_approval_policies_class_principal_op_scope_key;
DROP INDEX IF EXISTS write_approval_policies_identity;

CREATE UNIQUE INDEX write_approval_policies_identity
  ON write_approval_policies (
    organization_id,
    resource_class,
    COALESCE(principal_kind, ''),
    COALESCE(principal_id, ''),
    COALESCE(operation_key, ''),
    COALESCE(entity_type_slug, ''),
    COALESCE(field_path, ''),
    COALESCE(entity_id, 0),
    COALESCE(target_agent_id, '')
  );

-- When the target agent is deleted, drop exceptions that named it.
-- NULL target_agent_id rows are not checked by this FK.
ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_target_agent_fkey;

ALTER TABLE write_approval_policies
  ADD CONSTRAINT write_approval_policies_target_agent_fkey
  FOREIGN KEY (organization_id, target_agent_id)
  REFERENCES agents (organization_id, id)
  ON DELETE CASCADE;

-- migrate:down
ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_target_agent_fkey;

ALTER TABLE write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_scope_class_check;

DROP INDEX IF EXISTS write_approval_policies_identity;

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

ALTER TABLE write_approval_policies
  DROP COLUMN IF EXISTS target_agent_id;
