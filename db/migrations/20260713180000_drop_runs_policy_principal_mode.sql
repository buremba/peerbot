-- migrate:up
--
-- Retire runs.policy_principal_mode. Write-policy is a single envelope
-- (write_approval_policies.principal_mode already dropped); this column was
-- only written for approve-time recheck that never read it.

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_mode_check;

ALTER TABLE runs
  DROP COLUMN IF EXISTS policy_principal_mode;

-- migrate:down
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS policy_principal_mode text NULL;

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_mode_check;

ALTER TABLE runs
  ADD CONSTRAINT runs_policy_principal_mode_check
  CHECK (
    policy_principal_mode IS NULL
    OR policy_principal_mode IN ('attended', 'autonomous')
  ) NOT VALID;

ALTER TABLE runs
  VALIDATE CONSTRAINT runs_policy_principal_mode_check;
