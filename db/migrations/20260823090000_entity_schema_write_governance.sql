-- migrate:up

-- Entity-schema governance reuses the existing write-policy child table. The
-- six semantic actions are intentionally explicit: relationship rule edits are
-- governed as update_relationship_type, so every schema mutation has a policy
-- action without adding a second policy or approval store.
ALTER TABLE public.write_policy_action_effects
  DROP CONSTRAINT IF EXISTS write_policy_action_effects_action_check;

ALTER TABLE public.write_policy_action_effects
  ADD CONSTRAINT write_policy_action_effects_action_check
  CHECK (action IN (
    'read', 'create', 'update', 'delete', 'execute',
    'create_type', 'update_type', 'delete_type',
    'create_relationship_type', 'update_relationship_type', 'delete_relationship_type'
  )) NOT VALID;

ALTER TABLE public.write_policy_action_effects
  VALIDATE CONSTRAINT write_policy_action_effects_action_check;

-- migrate:down

DELETE FROM public.write_policy_action_effects
WHERE action IN (
  'create_type', 'update_type', 'delete_type',
  'create_relationship_type', 'update_relationship_type', 'delete_relationship_type'
);

ALTER TABLE public.write_policy_action_effects
  DROP CONSTRAINT IF EXISTS write_policy_action_effects_action_check;

ALTER TABLE public.write_policy_action_effects
  ADD CONSTRAINT write_policy_action_effects_action_check
  CHECK (action IN ('read', 'create', 'update', 'delete', 'execute')) NOT VALID;

ALTER TABLE public.write_policy_action_effects
  VALIDATE CONSTRAINT write_policy_action_effects_action_check;
