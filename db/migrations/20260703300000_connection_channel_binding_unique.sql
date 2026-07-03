-- migrate:up transaction:false

-- A channel binding routes through one concrete chat connection; this index is
-- the ON CONFLICT (organization_id, connection_id, channel_id) arbiter for the
-- new bind upserts. Non-partial on purpose: NULLs are distinct, so legacy rows
-- with connection_id IS NULL coexist, and a plain (non-WHERE) conflict target
-- can infer it. Built before 20260703300040 drops the legacy uniqueness so
-- there is no window without duplicate protection. CONCURRENTLY
-- (transaction:false, one statement) to avoid locking the bindings table.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_channel_bindings_connection_channel_unique
  ON public.agent_channel_bindings (organization_id, connection_id, channel_id);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.agent_channel_bindings_connection_channel_unique;
