-- migrate:up

-- Let an auth_profile of kind 'browser_session' live on a specific device worker
-- instead of holding cookies in auth_data. When device_worker_id is set, cookies
-- live on disk inside the Mac app's managed --user-data-dir at user_data_dir;
-- the server never sees them. Cloud/fleet path (device_worker_id NULL,
-- auth_data populated) is unchanged.

ALTER TABLE public.auth_profiles
    ADD COLUMN IF NOT EXISTS device_worker_id uuid,
    ADD COLUMN IF NOT EXISTS browser_kind text,
    ADD COLUMN IF NOT EXISTS user_data_dir text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_device_worker_id_fkey'
    ) THEN
        ALTER TABLE public.auth_profiles
            ADD CONSTRAINT auth_profiles_device_worker_id_fkey
            FOREIGN KEY (device_worker_id)
            REFERENCES public.device_workers (id)
            ON DELETE CASCADE;
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_browser_kind_check'
    ) THEN
        ALTER TABLE public.auth_profiles
            ADD CONSTRAINT auth_profiles_browser_kind_check
            CHECK (browser_kind IS NULL OR browser_kind = ANY (ARRAY['chrome','brave','arc','edge']));
    END IF;
END$$;

CREATE INDEX IF NOT EXISTS auth_profiles_device_worker_idx
    ON public.auth_profiles (device_worker_id)
    WHERE device_worker_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.auth_profiles_device_worker_idx;
ALTER TABLE public.auth_profiles
    DROP CONSTRAINT IF EXISTS auth_profiles_browser_kind_check,
    DROP CONSTRAINT IF EXISTS auth_profiles_device_worker_id_fkey,
    DROP COLUMN IF EXISTS user_data_dir,
    DROP COLUMN IF EXISTS browser_kind,
    DROP COLUMN IF EXISTS device_worker_id;
