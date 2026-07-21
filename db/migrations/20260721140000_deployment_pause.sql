-- migrate:up

-- Org-level "promotions paused" flag for config deployments (#2045 follow-up,
-- Vercel-style paused auto-promotion). `lobu rollback` sets it; a subsequent
-- `lobu apply` refuses while it is set until the operator passes --resume
-- (which clears it) — so a CI apply can never silently re-promote over a
-- deliberate rollback. One row per organization; Postgres-mediated so every
-- replica and every operator sees the same state.
CREATE TABLE IF NOT EXISTS public.deployment_pause (
  organization_id text PRIMARY KEY,
  paused_at timestamp with time zone NOT NULL DEFAULT now(),
  -- The rollback deployment that set the pause, and the deployment it
  -- restored — the apply error message points operators at both.
  apply_id text,
  rollback_of text,
  paused_by text
);

-- migrate:down

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.deployment_pause;
