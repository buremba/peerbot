-- migrate:up

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS approved_input jsonb;

-- migrate:down

ALTER TABLE public.runs
    DROP COLUMN IF EXISTS approved_input;
