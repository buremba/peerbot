-- migrate:up
--
-- Allow entity `read` as a first-class write-policy action so an agent's
-- envelope (and the org floor) can say which entity types that principal may
-- read. Default remains auto (no row = unrestricted within the org) — same as
-- today's manage_entity get/list behavior for agents.

ALTER TABLE write_policy_action_effects
  DROP CONSTRAINT IF EXISTS write_policy_action_effects_action_check;

ALTER TABLE write_policy_action_effects
  ADD CONSTRAINT write_policy_action_effects_action_check
  CHECK (action IN ('create', 'update', 'delete', 'execute', 'read')) NOT VALID;
ALTER TABLE write_policy_action_effects
  VALIDATE CONSTRAINT write_policy_action_effects_action_check;

-- migrate:down
ALTER TABLE write_policy_action_effects
  DROP CONSTRAINT IF EXISTS write_policy_action_effects_action_check;

-- Drop any entity read rows before re-tightening the CHECK.
DELETE FROM write_policy_action_effects WHERE action = 'read';

ALTER TABLE write_policy_action_effects
  ADD CONSTRAINT write_policy_action_effects_action_check
  CHECK (action IN ('create', 'update', 'delete', 'execute')) NOT VALID;
ALTER TABLE write_policy_action_effects
  VALIDATE CONSTRAINT write_policy_action_effects_action_check;
