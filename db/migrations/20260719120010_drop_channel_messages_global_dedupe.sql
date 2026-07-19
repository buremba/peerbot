-- migrate:up transaction:false

-- The organization-scoped unique index was built concurrently in the preceding
-- migration. Drop the old global constraint so the same source message can be
-- captured once for every subscribed organization. Old replicas use the former
-- three-column ON CONFLICT target; during the brief rolling window their
-- best-effort transcript writes can fail without blocking webhook handling or
-- agent turns. New replicas use the organization-scoped arbiter.
ALTER TABLE public.channel_messages
  DROP CONSTRAINT IF EXISTS channel_messages_dedup;

-- Rollback recreates the legacy arbiter as a plain index rather than a
-- constraint. Remove either representation so this migration is replayable.
-- squawk-ignore require-concurrent-index-deletion -- the ALTER above already takes ACCESS EXCLUSIVE; dbmate sends this section as one query, which prevents CONCURRENTLY
DROP INDEX IF EXISTS public.channel_messages_dedup;

-- migrate:down transaction:false

-- Rollback is possible only before cross-organization duplicates have landed.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_messages_dedup
  ON public.channel_messages (connection_id, channel_id, platform_message_id);
