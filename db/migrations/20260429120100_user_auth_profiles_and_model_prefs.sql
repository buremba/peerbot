-- migrate:up

-- Phase 6: PG-backed storage for per-user runtime state previously held in Redis.
--
-- These tables replace Redis-keyed structures:
--   user:auth-profiles:{userId}:{agentId}      → user_auth_profiles
--   {providerId}:model_preference:{userId}     → user_model_preferences
--
-- The previous Redis layout kept the credential/refreshToken in the secret
-- store and persisted only refs in the cached JSON; we keep that contract
-- and store the same JSON document in `profiles` here.

CREATE TABLE IF NOT EXISTS public.user_auth_profiles (
  user_id text NOT NULL,
  agent_id text NOT NULL,
  profiles jsonb DEFAULT '[]'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);

CREATE INDEX IF NOT EXISTS user_auth_profiles_agent_id_idx
  ON public.user_auth_profiles (agent_id);


CREATE TABLE IF NOT EXISTS public.user_model_preferences (
  user_id text NOT NULL,
  provider_id text NOT NULL,
  model text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);

-- migrate:down

DROP TABLE IF EXISTS public.user_model_preferences;
DROP TABLE IF EXISTS public.user_auth_profiles;
