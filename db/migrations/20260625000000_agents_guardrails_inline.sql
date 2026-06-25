-- migrate:up

-- Operator-authored custom guardrails (inline LLM judges) for an agent. Each
-- entry carries its own stage + policy + model and is materialized into a judge
-- guardrail at resolve time, in addition to the named built-ins in `guardrails`.
-- Mirrors the existing `guardrails` jsonb column (nullable, constant default →
-- no table rewrite, squawk-safe).
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS guardrails_inline jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.agents.guardrails_inline IS
    'Operator-authored custom guardrails: array of {name, enabled, stage, policy, model?, tools?}. Enabled entries resolve into judge guardrails alongside the named built-ins in guardrails.';

-- migrate:down

ALTER TABLE public.agents DROP COLUMN IF EXISTS guardrails_inline;
