-- migrate:up

-- An agent conversation turn executed as one isolate job on the connector
-- worker fleet. Distinct from 'chat_message', which carries the gateway's own
-- MessagePayload: an 'agent_turn' row carries a self-contained execution
-- envelope in action_input (model, prompt, transcript, proxy URL, allowlist)
-- and is completed through /api/workers/complete-agent-turn.
--
-- organization_id is required for the new type, so it joins
-- runs_legacy_org_required rather than being exempt from it.
--
-- Both lists below are the prior constraint definitions with 'agent_turn'
-- added and nothing else changed. NOT VALID + VALIDATE keeps the rewrite off
-- the table's write path: the ADD takes a brief lock, the VALIDATE scans
-- without blocking writes.

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'automation'::text, 'automation_eval'::text,
      'auth'::text, 'chat_message'::text, 'agent_turn'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_run_type_check;

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_legacy_org_required;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_legacy_org_required CHECK (
    (run_type <> ALL (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'automation'::text, 'auth'::text, 'agent_turn'::text
    ])) OR organization_id IS NOT NULL
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_legacy_org_required;

-- migrate:down

-- Restores both constraints to their pre-'agent_turn' definitions. This is
-- only reversible while no agent_turn rows exist: VALIDATE would reject them,
-- which is the correct outcome — a down migration must not silently keep rows
-- the schema no longer admits.

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'automation'::text, 'automation_eval'::text,
      'auth'::text, 'chat_message'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_run_type_check;

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_legacy_org_required;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_legacy_org_required CHECK (
    (run_type <> ALL (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'automation'::text, 'auth'::text
    ])) OR organization_id IS NOT NULL
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_legacy_org_required;
