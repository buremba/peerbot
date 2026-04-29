-- migrate:up

-- Phase 6: NOTIFY trigger for invalidatableCache invalidation.
--
-- The agent-related runtime caches (formerly Redis-backed) read agents,
-- channel bindings, user-agent associations, and per-(user,agent) auth
-- profiles directly from Postgres. Each gateway process keeps a small
-- read-through cache invalidated by `pg_notify('agent_changed', <key>)`.
--
-- We emit a single channel name and let the cache implementation match
-- the payload against the cached key. Channels are deliberately coarse
-- (one per logical resource family) to keep the postmaster's notification
-- table small — see invalidatable-cache.ts.

CREATE OR REPLACE FUNCTION public.notify_agent_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('agent_changed', COALESCE(NEW.id, OLD.id));
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS agents_changed_notify ON public.agents;
CREATE TRIGGER agents_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.notify_agent_changed();


-- Channel bindings: payload is "<platform>:<teamId|->:<channelId>" so the
-- in-process cache (keyed identically) can drop just the affected entry.
CREATE OR REPLACE FUNCTION public.notify_channel_binding_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec record;
  payload text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := OLD;
  ELSE
    rec := NEW;
  END IF;
  payload := format(
    '%s:%s:%s',
    rec.platform,
    COALESCE(rec.team_id, '-'),
    rec.channel_id
  );
  PERFORM pg_notify('channel_binding_changed', payload);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS agent_channel_bindings_changed_notify ON public.agent_channel_bindings;
CREATE TRIGGER agent_channel_bindings_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON public.agent_channel_bindings
  FOR EACH ROW EXECUTE FUNCTION public.notify_channel_binding_changed();


-- User-agent associations: payload is "<platform>:<userId>" so the
-- agent listing cache for a single user can be dropped without affecting
-- other users.
CREATE OR REPLACE FUNCTION public.notify_agent_users_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := OLD;
  ELSE
    rec := NEW;
  END IF;
  PERFORM pg_notify(
    'agent_users_changed',
    format('%s:%s', rec.platform, rec.user_id)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS agent_users_changed_notify ON public.agent_users;
CREATE TRIGGER agent_users_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON public.agent_users
  FOR EACH ROW EXECUTE FUNCTION public.notify_agent_users_changed();

-- migrate:down

DROP TRIGGER IF EXISTS agent_users_changed_notify ON public.agent_users;
DROP FUNCTION IF EXISTS public.notify_agent_users_changed();

DROP TRIGGER IF EXISTS agent_channel_bindings_changed_notify ON public.agent_channel_bindings;
DROP FUNCTION IF EXISTS public.notify_channel_binding_changed();

DROP TRIGGER IF EXISTS agents_changed_notify ON public.agents;
DROP FUNCTION IF EXISTS public.notify_agent_changed();
