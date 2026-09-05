-- An agent conversation turn executed as one isolate job on the connector
-- worker fleet. Distinct from 'chat_message', a lobu-queue row the gateway
-- drains to a subprocess worker: an 'agent_turn' row is only ever claimed by a
-- fleet worker that advertises the lane, and runs through IsolateExecutor.
--
-- Its producer always has an organization, so 'agent_turn' joins
-- runs_legacy_org_required and every such row carries organization_id.

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
