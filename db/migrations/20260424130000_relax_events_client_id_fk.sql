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

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_client_id_fkey;

ALTER TABLE public.events
    ADD CONSTRAINT events_client_id_fkey
    FOREIGN KEY (client_id)
    REFERENCES public.oauth_clients(id)
    ON DELETE SET NULL;

-- migrate:down

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_client_id_fkey;

ALTER TABLE public.events
    ADD CONSTRAINT events_client_id_fkey
    FOREIGN KEY (client_id)
    REFERENCES public.oauth_clients(id);
