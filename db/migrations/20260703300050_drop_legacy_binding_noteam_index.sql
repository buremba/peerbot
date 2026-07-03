-- migrate:up transaction:false

-- Companion to 20260703300040: the tenantless (Telegram) legacy arbiter goes
-- for the same reason. CONCURRENTLY (transaction:false, one statement) to
-- avoid locking the bindings table.
DROP INDEX CONCURRENTLY IF EXISTS public.agent_channel_bindings_org_no_team_unique;

-- migrate:down transaction:false

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_channel_bindings_org_no_team_unique
  ON public.agent_channel_bindings (organization_id, platform, channel_id)
  WHERE team_id IS NULL;
