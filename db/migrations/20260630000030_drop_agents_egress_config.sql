-- migrate:up

-- Contract phase of the egress-judge consolidation. PR #1592 moved the LLM
-- egress judge into inline guardrails (agents.guardrails_inline entries with
-- stage='egress' and a domains selector), leaving agents.egress_config
-- write-dead. Production was checked before this migration was created:
--   SELECT count(*) FROM agents WHERE egress_config <> '{}'::jsonb;
-- returned 0, so no live legacy policy data is being discarded.
--
-- Safe after #1592 is deployed to every app replica: pre-#1592 pods wrote this
-- column on agent-settings saves, so this must remain a post-deploy contract
-- migration. DROP COLUMN is an O(1) catalog change with a brief ACCESS
-- EXCLUSIVE lock; IF EXISTS keeps local/embedded replays idempotent.

ALTER TABLE public.agents DROP COLUMN IF EXISTS egress_config;

-- migrate:down

-- Rollback-only path (dev): restore the original baseline column shape. Dropped
-- data is not recoverable because the column was write-dead before removal.
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS egress_config jsonb DEFAULT '{}'::jsonb;
