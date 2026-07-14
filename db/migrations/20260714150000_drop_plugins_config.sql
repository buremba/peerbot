-- migrate:up
-- squawk-ignore ban-drop-column -- contract phase: #1934 removed every read/write and the production rollout has no pre-#1934 pods remaining
ALTER TABLE public.agents
  DROP COLUMN IF EXISTS plugins_config;

-- migrate:down
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS plugins_config jsonb DEFAULT '{}'::jsonb;
