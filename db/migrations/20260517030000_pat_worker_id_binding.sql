-- migrate:up

-- Bind PATs minted via /api/me/devices/mint-child-token to a specific
-- worker_id. Without this, a chrome-extension child PAT could post any
-- worker_id at /api/workers/poll and register a new device_workers row
-- under a different platform, bypassing the gateway's capability
-- authorization. The poll handler now refuses a request whose body's
-- `worker_id` doesn't match the PAT's bound `worker_id` (when non-NULL).
--
-- Legacy PATs (CLI tokens, OAuth-issued bearers via dynamic client
-- registration on the Mac/iOS bridges) keep worker_id = NULL; the poll
-- handler treats NULL as "no binding" and lets the body's value pass.

ALTER TABLE public.personal_access_tokens
  ADD COLUMN IF NOT EXISTS worker_id text;

CREATE INDEX IF NOT EXISTS idx_personal_access_tokens_worker_id
  ON public.personal_access_tokens (worker_id)
  WHERE worker_id IS NOT NULL;

COMMENT ON COLUMN public.personal_access_tokens.worker_id IS
  'Optional binding to a specific device_workers.worker_id. Set by /api/me/devices/mint-child-token. When non-NULL, /api/workers/poll requires the request body''s worker_id to match.';

-- migrate:down

DROP INDEX IF EXISTS public.idx_personal_access_tokens_worker_id;
ALTER TABLE public.personal_access_tokens DROP COLUMN IF EXISTS worker_id;
