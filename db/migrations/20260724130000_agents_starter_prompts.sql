-- migrate:up

-- Config-authored starter chips for an agent's fresh-conversation view. When
-- set, they are served directly on the starters endpoint (no AI-generated
-- starters turn); empty/unset means the agent generates starters dynamically
-- from workspace state. Persisted as its own jsonb column on `agents` (agent
-- settings are per-field columns, mirrored by AgentSettingsStoredSchema and
-- postgres-stores rowToSettings/saveSettings — nesting into an existing blob
-- would break that contract).
--
-- Nullable, no default: existing rows read as NULL and use dynamic generation.
-- O(1) catalog add, no table rewrite.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS starter_prompts jsonb;

-- AI-generated starter chips, cached per agent+org.
--
-- Deliberately NOT on the `events` substrate. Per-conversation suggestion chips
-- live there because they are replayed with the transcript and superseded per
-- turn; starters are neither — they are a derived, disposable CACHE with
-- exactly one live value per (organization_id, agent_id), read by a single
-- lookup on the starters endpoint. Storing them as superseded events would
-- append a row per regeneration forever (append-only: nothing reclaims them).
--
-- One row per agent+org, refreshed with INSERT .. ON CONFLICT DO UPDATE.
-- Generation ordering is enforced by the durable, message-bound lease.
CREATE TABLE IF NOT EXISTS public.agent_starters (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  -- [{title, message}, ...] as sanitized by sanitizeSuggestionPrompts.
  prompts jsonb NOT NULL,
  -- Refresh inputs. `generated_at` limits successful refreshes to one per
  -- interval; `failed_at` backs off a generation that produced no usable chips.
  generated_at timestamptz NOT NULL DEFAULT now(),
  failed_at timestamptz,
  PRIMARY KEY (organization_id, agent_id)
);

-- migrate:down

DROP TABLE IF EXISTS public.agent_starters;

ALTER TABLE public.agents
  DROP COLUMN IF EXISTS starter_prompts;
