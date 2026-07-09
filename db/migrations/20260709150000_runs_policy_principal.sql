-- migrate:up

-- (sol review #5) Persist the trusted principal that queued a connector-action
-- run, so its write-gate policy can be RE-EVALUATED at approve time against the
-- principal that requested it — not the human who approves. Without this, a
-- deny/disabled installed AFTER queueing but BEFORE approval would not stop the
-- execution, and a principal-specific policy could not be re-checked at all.
--
-- Nullable + additive: existing rows (and every human-initiated run) carry NULL,
-- meaning "no per-principal policy applies", which is the correct default. Only
-- agent/watcher-queued runs populate these, so backfill is unnecessary.
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS policy_principal_kind text,
  ADD COLUMN IF NOT EXISTS policy_principal_id text;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_kind_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_policy_principal_kind_check CHECK (
    policy_principal_kind IS NULL
    OR policy_principal_kind IN ('agent', 'watcher', 'user')
  );

-- (sol review #7) `disabled` is only meaningful for the connector_action class
-- (an action turned off entirely). The widened mode CHECK from the expand
-- migration accepts it for every class; constrain it so a manual SQL write can't
-- leave an entity/agent_config row in a `disabled` state the resolver would then
-- have to fail closed on. deny/approval/auto stay legal for all classes.
ALTER TABLE public.write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_disabled_only_connector;
ALTER TABLE public.write_approval_policies
  ADD CONSTRAINT write_approval_policies_disabled_only_connector CHECK (
    resource_class = 'connector_action'
    OR (
      create_mode <> 'disabled'
      AND update_mode <> 'disabled'
      AND delete_mode <> 'disabled'
    )
  );

-- migrate:down

ALTER TABLE public.write_approval_policies
  DROP CONSTRAINT IF EXISTS write_approval_policies_disabled_only_connector;

ALTER TABLE public.runs
  DROP CONSTRAINT IF EXISTS runs_policy_principal_kind_check;
ALTER TABLE public.runs
  DROP COLUMN IF EXISTS policy_principal_id,
  DROP COLUMN IF EXISTS policy_principal_kind;
