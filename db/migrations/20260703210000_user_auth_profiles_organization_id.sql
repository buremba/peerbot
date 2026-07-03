-- migrate:up

-- Org-bucket OAuth: one subscription sign-in on the org inference-providers page
-- covers all of a user's agents in that org. Those profiles are stored under a
-- synthetic bucket key `agent_id = '__org_oauth__:<slug>'` that has NO matching
-- `agents` row, so the org can no longer be derived via the agents join. Add a
-- nullable `organization_id` the org-bucket write sets explicitly.
--
-- Nullable on purpose: only org-bucket rows populate it. Ordinary per-agent rows
-- leave it NULL and keep deriving their org from `agents.organization_id`
-- (`scanAllOAuth` COALESCEs the two). Without this column the token-refresh scan
-- would silently drop org-bucket profiles (INNER JOIN agents finds no row), and
-- their tokens would stop refreshing ~1h after sign-in — invisibly.
ALTER TABLE public.user_auth_profiles
  ADD COLUMN IF NOT EXISTS organization_id text;

-- migrate:down

ALTER TABLE public.user_auth_profiles
  DROP COLUMN IF EXISTS organization_id;
