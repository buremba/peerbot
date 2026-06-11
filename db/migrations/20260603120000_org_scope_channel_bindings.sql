-- migrate:up

-- Org-scope the channel-binding uniqueness.
--
-- Before: uniqueness was GLOBAL across all tenants —
--   UNIQUE (platform, channel_id, team_id)
--   + partial UNIQUE (platform, channel_id) WHERE team_id IS NULL
-- so two organizations could never independently bind the same
-- platform+channel. Worse, `createBinding` did
--   ON CONFLICT (...) DO UPDATE SET agent_id = EXCLUDED.agent_id,
--     organization_id = EXCLUDED.organization_id
-- so a second org binding the same platform+channel collided with the first
-- org's row and rewrote its `organization_id` to itself — a silent
-- cross-tenant takeover (the first org's binding vanished).
--
-- After: the key is org-scoped, so each org owns its own binding row for the
-- same platform+channel.
--
-- Migration safety: the new key is strictly MORE permissive than the old
-- global one (it adds `organization_id` as a leading column). Every set of
-- rows that satisfied the old global uniqueness trivially satisfies the
-- org-scoped uniqueness, so existing data migrates without conflict — no
-- pre-flight de-dup is required. All statements are idempotent
-- (DROP ... IF EXISTS / CREATE ... IF NOT EXISTS / guarded ADD CONSTRAINT)
-- so the forward delta replays cleanly per the embedded-runtime contract.

-- (1) Drop the global team-id-set UNIQUE constraint.
ALTER TABLE public.agent_channel_bindings
  DROP CONSTRAINT IF EXISTS agent_channel_bindings_platform_channel_id_team_id_key;

-- (2) Add the org-scoped UNIQUE constraint (covers the team_id-set case;
-- PG treats NULL team_id rows as distinct, so they don't conflict here).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_channel_bindings_org_platform_channel_team_key'
      AND conrelid = 'public.agent_channel_bindings'::regclass
  ) THEN
    ALTER TABLE public.agent_channel_bindings
      ADD CONSTRAINT agent_channel_bindings_org_platform_channel_team_key
      UNIQUE (organization_id, platform, channel_id, team_id);
  END IF;
END$$;

-- (3) Replace the global team_id-IS-NULL partial unique index with an
-- org-scoped one.
DROP INDEX IF EXISTS public.agent_channel_bindings_no_team_unique;
CREATE UNIQUE INDEX IF NOT EXISTS agent_channel_bindings_org_no_team_unique
  ON public.agent_channel_bindings USING btree (organization_id, platform, channel_id)
  WHERE (team_id IS NULL);

-- migrate:down

DROP INDEX IF EXISTS public.agent_channel_bindings_org_no_team_unique;
CREATE UNIQUE INDEX IF NOT EXISTS agent_channel_bindings_no_team_unique
  ON public.agent_channel_bindings USING btree (platform, channel_id)
  WHERE (team_id IS NULL);

ALTER TABLE public.agent_channel_bindings
  DROP CONSTRAINT IF EXISTS agent_channel_bindings_org_platform_channel_team_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_channel_bindings_platform_channel_id_team_id_key'
      AND conrelid = 'public.agent_channel_bindings'::regclass
  ) THEN
    ALTER TABLE public.agent_channel_bindings
      ADD CONSTRAINT agent_channel_bindings_platform_channel_id_team_id_key
      UNIQUE (platform, channel_id, team_id);
  END IF;
END$$;
