-- migrate:up

-- The (org, platform, channel, team) uniqueness must go: two chat apps in one
-- workspace may now independently bind the same channel, keyed by the
-- (org, connection_id, channel_id) index built in 20260703300000/…20.
-- Rolling-deploy note: old-code replicas upsert with ON CONFLICT on this
-- arbiter, so their bind commands error for the seconds-to-minutes until the
-- rollout completes — accepted (binds are rare, user-initiated, retryable;
-- keeping the constraint would break multi-app binding permanently instead).
ALTER TABLE public.agent_channel_bindings
  DROP CONSTRAINT IF EXISTS agent_channel_bindings_org_platform_channel_team_key;

-- migrate:down

-- No-op: restoring the legacy arbiter would fail wherever multi-app duplicate
-- bindings already exist. Dev rollback: recreate the constraint by hand after
-- deduping.
SELECT 1;
