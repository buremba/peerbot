-- migrate:up

-- Drop vestigial columns: every one is read/written by zero code across server,
-- core, agent-worker, cli, and the owletto frontend (audit 2026-06-16), and in
-- prod every row holds only the column default. None appear in the query_sql
-- table-schema allowlist (packages/server/src/utils/table-schema.ts), so no
-- scoped CTE emits them and this needs no two-phase expand/contract.
--
-- Currently-deployed prod code also doesn't reference them, so the rolling
-- Helm-hook upgrade is safe: old replicas running during `dbmate up` won't
-- touch the dropped columns. DROP COLUMN is an O(1) catalog flip under a brief
-- ACCESS EXCLUSIVE lock — no table rewrite for any of these types.
--
--   agents.agent_integrations / skill_registries — leftover jsonb config,
--       all rows default ('{}' / '[]').
--   agents.skill_auto_granted_domains — already removed from the baseline by
--       the #908 squash; only prod still carries it physically.
--   device_workers.first_seen_at / notification_budget_per_day — never read.
--   organization.repair_agents_enabled — flag with no reader.

ALTER TABLE public.agents DROP COLUMN IF EXISTS agent_integrations;
ALTER TABLE public.agents DROP COLUMN IF EXISTS skill_registries;
ALTER TABLE public.agents DROP COLUMN IF EXISTS skill_auto_granted_domains;
ALTER TABLE public.device_workers DROP COLUMN IF EXISTS first_seen_at;
ALTER TABLE public.device_workers DROP COLUMN IF EXISTS notification_budget_per_day;
ALTER TABLE public.organization DROP COLUMN IF EXISTS repair_agents_enabled;

-- migrate:down

ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS agent_integrations jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS skill_registries jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS skill_auto_granted_domains jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.device_workers
    ADD COLUMN IF NOT EXISTS first_seen_at timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE public.device_workers
    ADD COLUMN IF NOT EXISTS notification_budget_per_day integer DEFAULT 10 NOT NULL;
ALTER TABLE public.device_workers
    DROP CONSTRAINT IF EXISTS device_workers_notification_budget_per_day_nonneg;
ALTER TABLE public.device_workers
    ADD CONSTRAINT device_workers_notification_budget_per_day_nonneg CHECK (notification_budget_per_day >= 0);
ALTER TABLE public.organization
    ADD COLUMN IF NOT EXISTS repair_agents_enabled boolean DEFAULT true NOT NULL;
