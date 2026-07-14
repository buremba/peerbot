-- migrate:up

-- Immutable per-conversation sandbox pin. On a conversation's FIRST turn, freeze
-- the RESOLVED runtime selection (which provider + which environment's creds
-- execute this conversation's sandbox). Every later turn reads the pin instead of
-- re-resolving the agent's CURRENT environment — so an admin repointing
-- agents.environment_id never moves an existing conversation's sandbox
-- (one-conversation-one-sandbox), while new conversations pick up the new realm.
--
-- Why freeze the RESOLVED value, not a reference:
--  - The sandbox filesystem name is already conversation-stable
--    (sha256(org:agent:conversation), no provider in it — vercel.ts), so the pin
--    is a (provider, creds)-routing concern, not an FS one.
--  - We store the resolved mode + provider + environment id, NOT the secret
--    (creds rotate live behind the same environment id — desirable) and NOT the
--    tri-state "unset/deployment_default" marker (that would re-read the mutable
--    LOBU_RUNTIME_PROVIDER and could migrate a live conversation's FS). The
--    unset case is resolved down to a concrete mode ('builtin' local just-bash,
--    or 'provider' + provider id) and frozen.
--  - No FK to environments: it is hard-deleted (no deleted_at). A pinned env that
--    is later deleted/deactivated must FAIL CLOSED (matches PR-0), not dangle to
--    system creds — enforced in app code (resolveRuntimeCredentials: an env-bound
--    resolution never splices system env), not by a cascade.
--
-- Provider selection is SOLELY the agent's Environment. The deployment-wide
-- LOBU_RUNTIME_PROVIDER env var is intentionally NOT consulted: it only ever
-- named a provider KIND while credentials always come from the environments
-- vault, so it could never route a working sandbox on its own. INTENDED BREAKING
-- CHANGE: a self-host that set LOBU_RUNTIME_PROVIDER expecting remote bash (with
-- no Environment attached) now runs local just-bash — attach a provider
-- Environment to the agent instead.
--
-- sandbox_provider_id doubles as the "pinned yet?" guard: NULL = unpinned, and
-- the first-turn CAS is `... WHERE sandbox_provider_id IS NULL` for mode
-- 'provider'. Because 'builtin' has a NULL provider id too, sandbox_mode carries
-- the pinned/unpinned bit: NULL sandbox_mode = unpinned.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS sandbox_mode         text,   -- NULL=unpinned; 'builtin' | 'provider'
  ADD COLUMN IF NOT EXISTS sandbox_provider_id  text,   -- runtimeProviderId when mode='provider'
  ADD COLUMN IF NOT EXISTS sandbox_environment_id text, -- environments.id backing the provider creds (NULL for builtin)
  ADD COLUMN IF NOT EXISTS sandbox_pinned_at    timestamptz;

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres; guard each on pg_constraint
-- so the up migration is idempotent (a partial-failure rerun won't duplicate-
-- object error), matching the ADD COLUMN IF NOT EXISTS above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_sandbox_mode_check'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_sandbox_mode_check
        CHECK (sandbox_mode IS NULL OR sandbox_mode IN ('builtin', 'provider'));
  END IF;

  -- mode='provider' requires a provider id; mode='builtin' must not carry one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_sandbox_provider_consistent'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_sandbox_provider_consistent
        CHECK (
          (sandbox_mode = 'provider' AND sandbox_provider_id IS NOT NULL)
          OR (sandbox_mode = 'builtin' AND sandbox_provider_id IS NULL)
          OR (sandbox_mode IS NULL AND sandbox_provider_id IS NULL)
        );
  END IF;
END $$;

-- migrate:down
-- squawk-ignore ban-drop-column -- rollback path for columns introduced by this migration
ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_sandbox_provider_consistent,
  DROP CONSTRAINT IF EXISTS conversations_sandbox_mode_check,
  DROP COLUMN IF EXISTS sandbox_pinned_at,
  DROP COLUMN IF EXISTS sandbox_environment_id,
  DROP COLUMN IF EXISTS sandbox_provider_id,
  DROP COLUMN IF EXISTS sandbox_mode;
