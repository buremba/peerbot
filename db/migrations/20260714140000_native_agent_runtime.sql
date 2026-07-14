-- migrate:up
CREATE TABLE IF NOT EXISTS public.agent_run_input (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  agent_id text NOT NULL,
  conversation_id text NOT NULL,
  deployment_name text NOT NULL,
  run_id bigint NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  token_claims jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id, deployment_name, message_id),
  CONSTRAINT agent_run_input_status_check CHECK (status IN ('pending', 'completed'))
);

-- Keep local/retry migration application idempotent while this migration is
-- still unreleased and its table shape is evolving.
ALTER TABLE public.agent_run_input
  ADD COLUMN IF NOT EXISTS token_claims jsonb NOT NULL DEFAULT '{}'::jsonb;
-- squawk-ignore prefer-robust-stmts -- unreleased migration shape reconciliation; dbmate wraps the migration and this remains safe to retry
ALTER TABLE public.agent_run_input ALTER COLUMN token_claims DROP DEFAULT;

-- squawk-ignore require-concurrent-index-creation -- the table is created immediately above and has no traffic or existing rows to block
CREATE INDEX IF NOT EXISTS agent_run_input_pending_deployment
  ON public.agent_run_input (deployment_name, created_at)
  WHERE status = 'pending';

-- migrate:down
-- squawk-ignore ban-drop-table -- rollback path for the table introduced by this migration
DROP TABLE IF EXISTS public.agent_run_input;
