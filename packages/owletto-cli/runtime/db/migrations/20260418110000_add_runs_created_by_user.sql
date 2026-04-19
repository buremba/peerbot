-- migrate:up

-- Track which user initiated an interactive auth run so that only that user
-- can view the QR / credential artifact. Sensitive artifacts (WhatsApp QR,
-- OTP codes, OAuth consent URLs) must never be viewable by other org members.

ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS created_by_user_id text
    REFERENCES public."user"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_runs_created_by_user
    ON public.runs (created_by_user_id)
    WHERE created_by_user_id IS NOT NULL;


-- migrate:down

DROP INDEX IF EXISTS public.idx_runs_created_by_user;
ALTER TABLE public.runs DROP COLUMN IF EXISTS created_by_user_id;
