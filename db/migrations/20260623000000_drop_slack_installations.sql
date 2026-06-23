-- migrate:up

-- Contract phase of the Slack-install consolidation. Slack OAuth workspace
-- installs now live entirely in `app_installations` (provider=slack); every
-- consumer reads/writes through the generic AppInstallationStore + the Slack
-- install projection (lobu/stores/slack-installations.ts). The expand phase
-- (prior release) backfilled all rows and dual-wrote both tables during the
-- rolling deploy; this release runs no-read/no-write code against
-- slack_installations on every pod, so the bespoke table can go.
--
-- Safe to drop now: the data was backfilled into app_installations (idempotent),
-- the dual-write is gone, and no code path references slack_installations.
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.slack_installations;

-- migrate:down

-- Recreate the bespoke table (matches 20260619120000_slack_installations) so a
-- rollback past this migration restores the pre-consolidation shape. It comes
-- back empty; app_installations remains the source of truth, so a rollback would
-- also revert the consuming code that reads app_installations.
CREATE TABLE IF NOT EXISTS public.slack_installations (
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
        FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE,
    CONSTRAINT slack_installations_org_team_uniq UNIQUE (organization_id, team_id)
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS slack_installations_team_idx
    ON public.slack_installations (team_id);
