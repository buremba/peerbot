-- migrate:up

-- Per-workspace Slack app installs (the "Add to Slack" OAuth path).
--
-- Slack OAuth v2 hands back a DISTINCT bot token for each workspace the shared
-- Lobu app is installed into; we must persist that token to reply in that
-- workspace. This is an org/workspace-INSTALLATION resource, NOT an agent's
-- connection: one installed workspace routes to MANY agents via `/lobu link`
-- channel bindings, so it has no single owning agent. Modeling it as an
-- `agent_connections` row (which requires `agent_id NOT NULL` + an FK to
-- `agents`) forces a synthetic placeholder agent and couples the workspace's
-- lifecycle to a deletable agent (ON DELETE CASCADE). This table keeps the
-- token where it belongs — keyed on (org, team) — with no agent ownership.
--
-- The bot token is NOT stored here in plaintext: `config` holds a `secret://`
-- ref into the org-scoped secret store (same convention `agent_connections`
-- uses for `config.botToken`). Routing reads the token from the secret store
-- at hydration time.
CREATE TABLE public.slack_installations (
    id text NOT NULL,
    organization_id text NOT NULL,
    team_id text NOT NULL,
    team_name text,
    bot_user_id text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_installations_pkey PRIMARY KEY (id),
    CONSTRAINT slack_installations_status_check
        CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text, 'error'::text]))),
    CONSTRAINT slack_installations_org_fkey
        FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE
);

-- One installation row per workspace per org; re-install upserts in place.
CREATE UNIQUE INDEX slack_installations_org_team_idx
    ON public.slack_installations (organization_id, team_id);

-- Inbound `/slack/events` carries no org context, so we resolve the install by
-- team_id alone across orgs (same routing key as agent_connections today).
CREATE INDEX slack_installations_team_idx
    ON public.slack_installations (team_id);

-- migrate:down

DROP TABLE IF EXISTS public.slack_installations;
