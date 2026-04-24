-- migrate:up

-- The events table tags each row with the OAuth client that produced it via
-- `events.client_id -> oauth_clients.id`. The original FK had no ON DELETE
-- behaviour, so when an oauth_client row was removed (manual cleanup, e2e
-- teardown, expired registration) any in-flight token still issuing inserts
-- failed with `events_client_id_fkey` violations (Sentry: OWLETTO-34).
--
-- Match the relaxation already applied to other event-side FKs
-- (connection_id, feed_id, run_id) and let stale client references reset
-- to NULL instead of breaking inserts.
--
-- Add and validate the replacement constraint before the quick final swap so
-- existing traffic stays protected and the ACCESS EXCLUSIVE window is short.

ALTER TABLE public.events
    ADD CONSTRAINT events_client_id_fkey_v2
    FOREIGN KEY (client_id)
    REFERENCES public.oauth_clients(id)
    ON DELETE SET NULL
    NOT VALID;

ALTER TABLE public.events
    VALIDATE CONSTRAINT events_client_id_fkey_v2;

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_client_id_fkey;

ALTER TABLE public.events
    RENAME CONSTRAINT events_client_id_fkey_v2 TO events_client_id_fkey;

-- migrate:down

ALTER TABLE public.events
    ADD CONSTRAINT events_client_id_fkey_v2
    FOREIGN KEY (client_id)
    REFERENCES public.oauth_clients(id)
    NOT VALID;

ALTER TABLE public.events
    VALIDATE CONSTRAINT events_client_id_fkey_v2;

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_client_id_fkey;

ALTER TABLE public.events
    RENAME CONSTRAINT events_client_id_fkey_v2 TO events_client_id_fkey;
