-- migrate:up

-- Revert the goals primitive added in 20260517150000_goals_primitive.sql.
-- Agents already encapsulate the watcher-grouping use case via
-- watchers.agent_id; goals were a redundant nullable FK + parallel CRUD with
-- zero behavioral value. The primitive never shipped in a release.

DROP INDEX IF EXISTS idx_watchers_goal_id;

ALTER TABLE public.watchers
    DROP COLUMN IF EXISTS goal_id;

DROP INDEX IF EXISTS idx_goals_organization_id;

DROP TABLE IF EXISTS public.goals;

-- migrate:down

CREATE TABLE public.goals (
    id              bigserial PRIMARY KEY,
    organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
    slug            text NOT NULL,
    name            text NOT NULL,
    description     text,
    status          text NOT NULL DEFAULT 'active',
    template_key    text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    updated_at      timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT goals_status_check
        CHECK (status IN ('active', 'paused', 'archived')),
    CONSTRAINT goals_org_slug_unique
        UNIQUE (organization_id, slug)
);

CREATE INDEX idx_goals_organization_id
    ON public.goals (organization_id);

ALTER TABLE public.watchers
    ADD COLUMN goal_id bigint REFERENCES public.goals(id) ON DELETE SET NULL;

CREATE INDEX idx_watchers_goal_id
    ON public.watchers (goal_id)
    WHERE goal_id IS NOT NULL;
