-- migrate:up

-- Phase 6 follow-up: emit BOTH the OLD and NEW cache keys when a row's key
-- columns change in an UPDATE. The Phase-6 triggers only emitted the NEW
-- key, so a process that had the OLD key cached would miss the invalidation
-- and serve stale data until the TTL expired.

-- Phase 6 follow-up: add a partial unique index that treats NULL team_id as
-- a single equivalence class. Postgres unique constraints treat NULLs as
-- distinct, so the existing UNIQUE (platform, channel_id, team_id) lets
-- repeated upserts of (platform, channel_id, NULL) insert duplicate rows;
-- the matching ON CONFLICT clause never fires and a subsequent getBinding()
-- reads an arbitrary row.
--
-- Using a partial index lets the existing platform/channel_id/team_id
-- constraint stay in place for the team_id-set rows; the new index covers
-- the team_id-null branch.
CREATE UNIQUE INDEX IF NOT EXISTS agent_channel_bindings_no_team_unique
  ON public.agent_channel_bindings (platform, channel_id)
  WHERE team_id IS NULL;


CREATE OR REPLACE FUNCTION public.notify_channel_binding_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_payload text;
  old_payload text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify(
      'channel_binding_changed',
      format('%s:%s:%s', OLD.platform, COALESCE(OLD.team_id, '-'), OLD.channel_id)
    );
    RETURN OLD;
  END IF;

  new_payload := format(
    '%s:%s:%s', NEW.platform, COALESCE(NEW.team_id, '-'), NEW.channel_id
  );
  PERFORM pg_notify('channel_binding_changed', new_payload);

  IF TG_OP = 'UPDATE' THEN
    old_payload := format(
      '%s:%s:%s', OLD.platform, COALESCE(OLD.team_id, '-'), OLD.channel_id
    );
    IF old_payload <> new_payload THEN
      PERFORM pg_notify('channel_binding_changed', old_payload);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.notify_agent_users_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_payload text;
  old_payload text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify(
      'agent_users_changed', format('%s:%s', OLD.platform, OLD.user_id)
    );
    RETURN OLD;
  END IF;

  new_payload := format('%s:%s', NEW.platform, NEW.user_id);
  PERFORM pg_notify('agent_users_changed', new_payload);

  IF TG_OP = 'UPDATE' THEN
    old_payload := format('%s:%s', OLD.platform, OLD.user_id);
    IF old_payload <> new_payload THEN
      PERFORM pg_notify('agent_users_changed', old_payload);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- migrate:down

DROP INDEX IF EXISTS public.agent_channel_bindings_no_team_unique;

-- Restore the Phase-6 (pre-fix) function bodies, which only emitted the NEW key.
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
