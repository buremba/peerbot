-- migrate:up

-- Drop the NOTIFY triggers + functions that powered the InvalidatableCache.
-- The cache layer was removed: stores read-through to PG directly. Reads sit
-- at ~7 SELECTs per chat dispatch — well within PG capacity at current scale.
-- The runs-queue's pg_notify('runs_lobu:<queue>', ...) wakeup path is
-- unaffected (different channel, different trigger).

DROP TRIGGER IF EXISTS agent_users_changed_notify ON public.agent_users;
DROP FUNCTION IF EXISTS public.notify_agent_users_changed();

DROP TRIGGER IF EXISTS agent_channel_bindings_changed_notify ON public.agent_channel_bindings;
DROP FUNCTION IF EXISTS public.notify_channel_binding_changed();

DROP TRIGGER IF EXISTS agents_changed_notify ON public.agents;
DROP FUNCTION IF EXISTS public.notify_agent_changed();

-- migrate:down

-- Restoration mirrors 20260429120000_agent_changed_notify.sql +
-- 20260429120200_fix_notify_old_keys.sql; if you need to roll back, replay
-- those by hand. We don't reproduce them here because the cache that consumed
-- these channels no longer exists — a rollback to the old behavior requires
-- restoring the cache code too.
SELECT 1;
