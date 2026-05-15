-- migrate:up
-- Phase C: swap `agents` PK from globally-unique `id` to per-org composite
-- `(organization_id, id)`. The application has always treated agents as
-- org-scoped (every read/list filters by organization_id) but the global PK
-- silently blocked two orgs from sharing an agent ID — for example, a stale
-- `food-ordering` in one org would prevent `food-ordering` in another.
--
-- Phase A (20260515120000) added the org column + composite indexes on the
-- 5 FK-holding child tables and backfilled values from agents. Phase B (the
-- application-code refactor in this PR) plumbs `organization_id` through every
-- INSERT/UPDATE/DELETE/SELECT touching these tables. This migration is the
-- final structural swap: it drops the single-column PK + FKs, adds the
-- composite PK + FKs, and widens the per-(agent,kind,pattern) uniques on
-- agent_users / agent_grants / grants with organization_id.

-- ── 0. Set NOT NULL on the columns Phase A backfilled.
-- Backfill defensively in case any rows snuck in NULL (e.g. embedded PGlite
-- installs that bypassed the dbmate runner during a partial state).
UPDATE public.agent_grants           c SET organization_id = a.organization_id FROM public.agents a WHERE c.organization_id IS NULL AND c.agent_id = a.id;
UPDATE public.agent_connections      c SET organization_id = a.organization_id FROM public.agents a WHERE c.organization_id IS NULL AND c.agent_id = a.id;
UPDATE public.agent_users            c SET organization_id = a.organization_id FROM public.agents a WHERE c.organization_id IS NULL AND c.agent_id = a.id;
UPDATE public.agent_channel_bindings c SET organization_id = a.organization_id FROM public.agents a WHERE c.organization_id IS NULL AND c.agent_id = a.id;
UPDATE public.grants                 c SET organization_id = a.organization_id FROM public.agents a WHERE c.organization_id IS NULL AND c.agent_id = a.id;

-- Drop any orphan rows (agent_id with no matching agents row). Backfill
-- can't recover these.
DELETE FROM public.agent_grants           WHERE organization_id IS NULL;
DELETE FROM public.agent_connections      WHERE organization_id IS NULL;
DELETE FROM public.agent_users            WHERE organization_id IS NULL;
DELETE FROM public.agent_channel_bindings WHERE organization_id IS NULL;
DELETE FROM public.grants                 WHERE organization_id IS NULL;

ALTER TABLE public.agent_grants           ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.agent_connections      ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.agent_users            ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.agent_channel_bindings ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.grants                 ALTER COLUMN organization_id SET NOT NULL;

-- ── 1. Drop the 6 single-column FKs into agents(id).
ALTER TABLE public.agent_grants           DROP CONSTRAINT IF EXISTS agent_grants_agent_id_fkey;
ALTER TABLE public.agent_connections      DROP CONSTRAINT IF EXISTS agent_connections_agent_id_fkey;
ALTER TABLE public.agent_users            DROP CONSTRAINT IF EXISTS agent_users_agent_id_fkey;
ALTER TABLE public.agent_channel_bindings DROP CONSTRAINT IF EXISTS agent_channel_bindings_agent_id_fkey;
ALTER TABLE public.grants                 DROP CONSTRAINT IF EXISTS grants_agent_id_fkey;
ALTER TABLE public.scheduled_jobs         DROP CONSTRAINT IF EXISTS scheduled_jobs_agent_fkey;

-- ── 2. Drop the unique/PK constraints on child tables that scope to bare agent_id.
ALTER TABLE public.agent_grants DROP CONSTRAINT IF EXISTS agent_grants_agent_id_pattern_key;
ALTER TABLE public.agent_users  DROP CONSTRAINT IF EXISTS agent_users_pkey;
ALTER TABLE public.grants       DROP CONSTRAINT IF EXISTS grants_pkey;

-- ── 3. Swap the PK on agents from (id) to (organization_id, id).
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_pkey;
ALTER TABLE public.agents ADD CONSTRAINT agents_pkey PRIMARY KEY (organization_id, id);

-- ── 4. Re-add per-org-scoped uniques on the child tables.
ALTER TABLE public.agent_grants
  ADD CONSTRAINT agent_grants_org_agent_pattern_key UNIQUE (organization_id, agent_id, pattern);
ALTER TABLE public.agent_users
  ADD CONSTRAINT agent_users_pkey PRIMARY KEY (organization_id, agent_id, platform, user_id);
ALTER TABLE public.grants
  ADD CONSTRAINT grants_pkey PRIMARY KEY (organization_id, agent_id, kind, pattern);

-- ── 5. Re-add composite FKs (organization_id, agent_id) → agents(organization_id, id).
ALTER TABLE public.agent_grants
  ADD CONSTRAINT agent_grants_org_agent_fkey
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE;
ALTER TABLE public.agent_connections
  ADD CONSTRAINT agent_connections_org_agent_fkey
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE;
ALTER TABLE public.agent_users
  ADD CONSTRAINT agent_users_org_agent_fkey
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE;
ALTER TABLE public.agent_channel_bindings
  ADD CONSTRAINT agent_channel_bindings_org_agent_fkey
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE;
ALTER TABLE public.grants
  ADD CONSTRAINT grants_org_agent_fkey
  FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE;
ALTER TABLE public.scheduled_jobs
  ADD CONSTRAINT scheduled_jobs_org_agent_fkey
  FOREIGN KEY (organization_id, created_by_agent) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE;

-- migrate:down
-- Reverse the swap. NOTE: this WILL FAIL if two orgs ended up sharing an
-- agent ID after this migration shipped (the previous PK on (id) requires
-- global uniqueness). That's by design — this migration's whole purpose is
-- to allow per-org agent IDs that the old PK forbids.

ALTER TABLE public.scheduled_jobs         DROP CONSTRAINT IF EXISTS scheduled_jobs_org_agent_fkey;
ALTER TABLE public.grants                 DROP CONSTRAINT IF EXISTS grants_org_agent_fkey;
ALTER TABLE public.agent_channel_bindings DROP CONSTRAINT IF EXISTS agent_channel_bindings_org_agent_fkey;
ALTER TABLE public.agent_users            DROP CONSTRAINT IF EXISTS agent_users_org_agent_fkey;
ALTER TABLE public.agent_connections      DROP CONSTRAINT IF EXISTS agent_connections_org_agent_fkey;
ALTER TABLE public.agent_grants           DROP CONSTRAINT IF EXISTS agent_grants_org_agent_fkey;

ALTER TABLE public.grants       DROP CONSTRAINT IF EXISTS grants_pkey;
ALTER TABLE public.agent_users  DROP CONSTRAINT IF EXISTS agent_users_pkey;
ALTER TABLE public.agent_grants DROP CONSTRAINT IF EXISTS agent_grants_org_agent_pattern_key;

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_pkey;
ALTER TABLE public.agents ADD CONSTRAINT agents_pkey PRIMARY KEY (id);

ALTER TABLE public.agent_grants ADD CONSTRAINT agent_grants_agent_id_pattern_key UNIQUE (agent_id, pattern);
ALTER TABLE public.agent_users  ADD CONSTRAINT agent_users_pkey PRIMARY KEY (agent_id, platform, user_id);
ALTER TABLE public.grants       ADD CONSTRAINT grants_pkey PRIMARY KEY (agent_id, kind, pattern);

ALTER TABLE public.agent_grants
  ADD CONSTRAINT agent_grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE public.agent_connections
  ADD CONSTRAINT agent_connections_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE public.agent_users
  ADD CONSTRAINT agent_users_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE public.agent_channel_bindings
  ADD CONSTRAINT agent_channel_bindings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE public.grants
  ADD CONSTRAINT grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE public.scheduled_jobs
  ADD CONSTRAINT scheduled_jobs_agent_fkey FOREIGN KEY (created_by_agent) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE public.grants                 ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.agent_channel_bindings ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.agent_users            ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.agent_connections      ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.agent_grants           ALTER COLUMN organization_id DROP NOT NULL;
