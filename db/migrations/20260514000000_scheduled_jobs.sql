-- migrate:up

-- User-driven scheduled jobs.
--
-- Why a separate table:
--   * `runs` already holds *fired* / *pending-to-fire* rows via
--     scheduler.spawn(). Each scheduled_jobs row is the *definition* of a
--     recurring (or one-shot) schedule — its source of truth.
--   * The ticker (`scheduled-jobs-tick`) scans this table on cron, spawns
--     a runs row per firing via TaskScheduler.spawn, and advances
--     next_run_at from `cron`. If the tick or a firing fails, the next
--     tick re-reads the same row (next_run_at didn't move forward) and
--     retries. Self-healing.
--   * Attribution lives here: who scheduled it (user or agent), what run
--     was the trigger, what event was the trigger. Lets "why did the
--     system act?" become a single JOIN.
--   * Cascade-on-delete: when an agent is deleted, all its schedules
--     evaporate via the FK — no orphan wake-ups firing into the void.

CREATE TABLE public.scheduled_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,

    -- What fires
    action_type text NOT NULL,        -- 'send_notification' | 'wake_agent' | ...
    action_args jsonb NOT NULL,       -- handler payload
    cron text,                        -- null = one-shot; cron string = recurring
    next_run_at timestamp with time zone NOT NULL,
    last_fired_at timestamp with time zone,
    last_fired_run_id bigint,         -- the runs.id from the most recent firing
    paused boolean NOT NULL DEFAULT false,

    description text NOT NULL,        -- human summary for the UI / audit

    -- Attribution
    created_by_user text,             -- user that scheduled it (null when agent did)
    created_by_agent text,            -- agent that scheduled it (null when user did)
    source_run_id bigint,             -- runs.id that originated the scheduling, if any
    source_event_id bigint,           -- events.id that originated, if any
    source_thread_id text,            -- chat-thread context, if any

    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT scheduled_jobs_attribution_check CHECK (
        created_by_user IS NOT NULL OR created_by_agent IS NOT NULL
    )
);

-- Cascade: dropping an agent kills its scheduled jobs (so an agent's
-- wake-ups don't outlive the agent itself). Conditional so the migration
-- works on installs where the agents table doesn't exist yet (very
-- old) — every row already has organization_id which is the harder constraint.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agents' AND relkind = 'r') THEN
        ALTER TABLE public.scheduled_jobs
            ADD CONSTRAINT scheduled_jobs_agent_fkey
            FOREIGN KEY (created_by_agent) REFERENCES public.agents(id) ON DELETE CASCADE;
    END IF;
END$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'runs' AND relkind = 'r') THEN
        ALTER TABLE public.scheduled_jobs
            ADD CONSTRAINT scheduled_jobs_source_run_fkey
            FOREIGN KEY (source_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;
    END IF;
END$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'events' AND relkind = 'r') THEN
        ALTER TABLE public.scheduled_jobs
            ADD CONSTRAINT scheduled_jobs_source_event_fkey
            FOREIGN KEY (source_event_id) REFERENCES public.events(id) ON DELETE SET NULL;
    END IF;
END$$;

-- Index: the ticker's hot read.
CREATE INDEX idx_scheduled_jobs_due
    ON public.scheduled_jobs (next_run_at)
    WHERE NOT paused;

-- Index: list per-agent / per-user.
CREATE INDEX idx_scheduled_jobs_org_agent
    ON public.scheduled_jobs (organization_id, created_by_agent)
    WHERE created_by_agent IS NOT NULL;

CREATE INDEX idx_scheduled_jobs_org_user
    ON public.scheduled_jobs (organization_id, created_by_user)
    WHERE created_by_user IS NOT NULL;

-- migrate:down

DROP TABLE IF EXISTS public.scheduled_jobs;
