-- migrate:up transaction:false

-- `events.created_by` represents the Owletto user that explicitly saved or
-- authored an event. Connector/scheduled/system-produced events have no human
-- saver; their provenance is represented by connector_key, connection_id,
-- feed_id, run_id, and client_id. Keep user attribution nullable and enforce
-- that any non-null value is a real user id instead of a sentinel string.
SET lock_timeout = '5s';

ALTER TABLE public.events
    ALTER COLUMN created_by DROP NOT NULL;

-- During a rolling deploy, old application pods may still write the historical
-- 'system'/'api' sentinel actors. Normalize only those known sentinels to NULL
-- before the FK sees them. Unknown non-user values should still be rejected.
CREATE OR REPLACE FUNCTION public.normalize_event_created_by()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.created_by IN ('system', 'api') AND NOT EXISTS (
        SELECT 1 FROM public."user" u WHERE u.id = NEW.created_by
    ) THEN
        NEW.created_by := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_event_created_by ON public.events;
CREATE TRIGGER normalize_event_created_by
    BEFORE INSERT OR UPDATE OF created_by ON public.events
    FOR EACH ROW
    EXECUTE FUNCTION public.normalize_event_created_by();

-- The previous integrity migration backfilled NULL event actors to 'system'.
-- Convert those sentinel values back to NULL. This uses idx_events_created_by.
SET lock_timeout = 0;
UPDATE public.events e
   SET created_by = NULL
 WHERE e.created_by IN ('system', 'api')
   AND NOT EXISTS (
       SELECT 1 FROM public."user" u WHERE u.id = e.created_by
   );
SET lock_timeout = '5s';

ALTER TABLE public.events
    ADD CONSTRAINT events_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES public."user"(id)
    ON DELETE SET NULL
    NOT VALID;

SET lock_timeout = 0;
ALTER TABLE public.events
    VALIDATE CONSTRAINT events_created_by_fkey;
SET lock_timeout = '5s';

-- migrate:down transaction:false

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_created_by_fkey;

DROP TRIGGER IF EXISTS normalize_event_created_by ON public.events;
DROP FUNCTION IF EXISTS public.normalize_event_created_by();

SET lock_timeout = 0;
UPDATE public.events
   SET created_by = 'system'
 WHERE created_by IS NULL;
SET lock_timeout = '5s';

ALTER TABLE public.events
    ALTER COLUMN created_by SET NOT NULL;
