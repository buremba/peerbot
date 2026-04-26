-- migrate:up transaction:false

-- DB integrity cleanup pass (non-transactional half).
--
-- Statements here would hold ACCESS EXCLUSIVE on busy tables for the
-- duration of a table scan or index build if wrapped in dbmate's default
-- per-migration transaction. Running with `transaction:false` lets each
-- statement release its lock on completion so VALIDATE CONSTRAINT only
-- needs SHARE UPDATE EXCLUSIVE (compatible with concurrent reads/writes)
-- and CREATE INDEX CONCURRENTLY can do its non-blocking build.
--
-- All steps are written to be idempotent: re-running after a partial
-- failure converges on the desired state. Validation aborts (RAISE
-- EXCEPTION) leave the migration NOT applied so dbmate retries cleanly.
--
-- Set a short lock_timeout so any contention surfaces as a fast failure
-- instead of a stuck deploy.
SET lock_timeout = '5s';

-- 1. events.created_by -> NOT NULL.
--    ADD CHECK NOT VALID adds the catalog row under a brief ACCESS
--    EXCLUSIVE without scanning the table. VALIDATE then takes only
--    SHARE UPDATE EXCLUSIVE so concurrent reads/writes are unaffected.
--    Once validated, SET NOT NULL is metadata-only because Postgres uses
--    the validated CHECK as proof there are no NULLs (PG12+).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.events'::regclass
           AND conname = 'events_created_by_not_null'
    ) THEN
        ALTER TABLE public.events
            ADD CONSTRAINT events_created_by_not_null
                CHECK (created_by IS NOT NULL) NOT VALID;
    END IF;
END$$;

ALTER TABLE public.events
    VALIDATE CONSTRAINT events_created_by_not_null;

ALTER TABLE public.events
    ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_created_by_not_null;

-- 2. Prune historical run_type values from the runs CHECK.
--    'embed_backfill' is still in active use and stays. 'insight' and
--    'code' are remnants of earlier orchestration models with no
--    production references; abort if any rows still carry them.
--    Use the NOT VALID + VALIDATE pattern so the swap doesn't hold
--    ACCESS EXCLUSIVE on runs across the table scan.

DO $$
DECLARE
    historical bigint;
BEGIN
    SELECT count(*) INTO historical
      FROM public.runs
     WHERE run_type IN ('insight', 'code');
    IF historical > 0 THEN
        RAISE EXCEPTION
            'runs has % row(s) with deprecated run_type (insight/code); migrate them before re-running',
            historical;
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.runs'::regclass
           AND conname = 'runs_run_type_check_v2'
    ) THEN
        ALTER TABLE public.runs
            ADD CONSTRAINT runs_run_type_check_v2
                CHECK (run_type = ANY (ARRAY[
                    'sync'::text,
                    'action'::text,
                    'embed_backfill'::text,
                    'watcher'::text,
                    'auth'::text
                ])) NOT VALID;
    END IF;
END$$;

ALTER TABLE public.runs
    VALIDATE CONSTRAINT runs_run_type_check_v2;

ALTER TABLE public.runs
    DROP CONSTRAINT IF EXISTS runs_run_type_check;

ALTER TABLE public.runs
    RENAME CONSTRAINT runs_run_type_check_v2 TO runs_run_type_check;

-- 3. Connections natural-key UNIQUE among live, authenticated rows.
--    A reconnect should refresh credentials in place, not insert a new
--    row. Partial index limits scope to non-deleted rows with an
--    account_id so soft-deletes and unauthenticated stubs don't block
--    re-creation. CONCURRENTLY avoids blocking writes during the build.

DO $$
DECLARE
    dup_groups bigint;
BEGIN
    SELECT count(*) INTO dup_groups
      FROM (
        SELECT 1
          FROM public.connections
         WHERE deleted_at IS NULL
           AND account_id IS NOT NULL
         GROUP BY organization_id, connector_key, account_id
        HAVING count(*) > 1
      ) t;
    IF dup_groups > 0 THEN
        RAISE EXCEPTION
            'connections has % duplicate (organization_id, connector_key, account_id) group(s) among live rows; dedupe before re-running',
            dup_groups;
    END IF;
END$$;

-- A previous failed run can leave an INVALID index behind. `IF NOT EXISTS`
-- alone would skip creation in that case, leaving uniqueness unenforced.
-- Drop first (no-op when the index doesn't exist) so the create always
-- produces a valid index.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_connections_org_connector_account_live;

CREATE UNIQUE INDEX CONCURRENTLY idx_connections_org_connector_account_live
    ON public.connections (organization_id, connector_key, account_id)
    WHERE deleted_at IS NULL AND account_id IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_connections_org_connector_account_live;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.runs'::regclass
           AND conname = 'runs_run_type_check'
    ) THEN
        ALTER TABLE public.runs DROP CONSTRAINT runs_run_type_check;
    END IF;
END$$;

ALTER TABLE public.runs
    ADD CONSTRAINT runs_run_type_check
        CHECK (run_type = ANY (ARRAY[
            'sync'::text,
            'action'::text,
            'code'::text,
            'insight'::text,
            'embed_backfill'::text,
            'watcher'::text,
            'auth'::text
        ]));

ALTER TABLE public.events
    ALTER COLUMN created_by DROP NOT NULL;
