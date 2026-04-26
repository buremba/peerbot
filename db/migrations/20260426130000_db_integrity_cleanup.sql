-- migrate:up

-- DB integrity cleanup pass (transactional half).
--
-- This file groups the changes that are safe to run inside dbmate's default
-- per-migration transaction: small-table tightenings and a UNIQUE swap that
-- only takes a brief ACCESS EXCLUSIVE lock. Operations that would hold a
-- long lock on busy tables (events.created_by NOT NULL, runs CHECK swap,
-- connections UNIQUE) live in the companion `transaction:false` migration
-- 20260426120001_db_integrity_cleanup_concurrent.sql.
--
-- Each tightening validates its precondition first and aborts loudly via
-- RAISE EXCEPTION if dirty data is present, so a green run on staging is a
-- strong signal for production.

-- 1. Drop the legacy events archive (renamed during the append-only cutover
--    on 2026-04-06; no application code references it).

DROP TABLE IF EXISTS public.events_legacy_pre_append_only_20260406;

-- 2. event_classifiers.status / organization_id -> NOT NULL.
--    `status` already has DEFAULT 'active' but is nullable; backfill any
--    pre-default rows then enforce. `organization_id` should never be null.

UPDATE public.event_classifiers
   SET status = 'active'
 WHERE status IS NULL;

DO $$
DECLARE
    null_org bigint;
BEGIN
    SELECT count(*) INTO null_org
      FROM public.event_classifiers
     WHERE organization_id IS NULL;
    IF null_org > 0 THEN
        RAISE EXCEPTION
            'event_classifiers has % row(s) with NULL organization_id; backfill before re-running this migration',
            null_org;
    END IF;
END$$;

ALTER TABLE public.event_classifiers
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN organization_id SET NOT NULL;

-- 3. watchers.status / organization_id -> NOT NULL.
--    `status` has DEFAULT 'active'; `organization_id` should never be null.

UPDATE public.watchers
   SET status = 'active'
 WHERE status IS NULL;

DO $$
DECLARE
    null_org bigint;
BEGIN
    SELECT count(*) INTO null_org
      FROM public.watchers
     WHERE organization_id IS NULL;
    IF null_org > 0 THEN
        RAISE EXCEPTION
            'watchers has % row(s) with NULL organization_id; backfill before re-running this migration',
            null_org;
    END IF;
END$$;

ALTER TABLE public.watchers
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN organization_id SET NOT NULL;

-- 4. event_classifiers UNIQUE -> NULLS NOT DISTINCT.
--    The previous (entity_id, watcher_id, slug) UNIQUE silently allowed
--    duplicates whenever entity_id or watcher_id were NULL because Postgres
--    treats NULLs as distinct. PG15+ supports NULLS NOT DISTINCT for the
--    intended "one row per scope+slug" semantic.
--    The table is small; the brief ACCESS EXCLUSIVE inside this transaction
--    is acceptable.

ALTER TABLE public.event_classifiers
    DROP CONSTRAINT event_classifiers_unique_per_insight;

ALTER TABLE public.event_classifiers
    ADD CONSTRAINT event_classifiers_unique_per_insight
        UNIQUE NULLS NOT DISTINCT (entity_id, watcher_id, slug);

-- migrate:down

ALTER TABLE public.event_classifiers
    DROP CONSTRAINT event_classifiers_unique_per_insight;

ALTER TABLE public.event_classifiers
    ADD CONSTRAINT event_classifiers_unique_per_insight
        UNIQUE (entity_id, watcher_id, slug);

ALTER TABLE public.watchers
    ALTER COLUMN organization_id DROP NOT NULL,
    ALTER COLUMN status DROP NOT NULL;

ALTER TABLE public.event_classifiers
    ALTER COLUMN organization_id DROP NOT NULL,
    ALTER COLUMN status DROP NOT NULL;

-- The legacy events table is intentionally not recreated on rollback.
