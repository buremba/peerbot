-- migrate:up

-- Goals primitive — a top-level handle that groups watchers under a single
-- user-facing intent (e.g. "Keep my CRM clean", "Watch competitors"). Each
-- watcher may optionally point at a goal; goals are the surface the
-- canvas/UI (#801) hangs off, while watchers stay the executable unit.
--
-- Schema notes:
-- - organization_id is `text` (the better-auth `organization.id`) to match
--   the rest of the schema; the issue body called it `integer`, but every
--   other org-scoped table (watchers, feeds, connections, …) uses text.
-- - `(organization_id, slug)` is unique so `lobu apply` can upsert by slug
--   the same way it does for watchers/agents.
-- - Goal-template loading from YAML is out of scope here; `template_key`
--   is just a free-form pointer for the future loader to claim.
-- - `metadata` is jsonb for forward-compat (icon, color, owner, etc.)
--   without another migration each time the UI grows a knob.

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

-- Watcher → goal link. NULL means "ungrouped" (today's behavior). ON DELETE
-- SET NULL keeps the watcher alive when its goal is archived/deleted; the
-- watcher just becomes ungrouped.
ALTER TABLE public.watchers
    ADD COLUMN goal_id bigint REFERENCES public.goals(id) ON DELETE SET NULL;

CREATE INDEX idx_watchers_goal_id
    ON public.watchers (goal_id)
    WHERE goal_id IS NOT NULL;

-- migrate:down

ALTER TABLE public.watchers
    DROP COLUMN IF EXISTS goal_id;

DROP TABLE IF EXISTS public.goals;
