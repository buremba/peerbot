-- migrate:up

-- Read-time JOIN support for the entity_identities graph.
--
-- applyEntityLinks (src/utils/entity-link-upsert.ts) stamps normalized
-- identifiers into events.metadata under the namespace key (metadata.email,
-- metadata.wa_jid, metadata.phone, …). Entity-scoped content queries then
-- JOIN:
--
--   events f
--   EXISTS (SELECT 1 FROM entity_identities ei
--           WHERE ei.entity_id = $X
--             AND ei.deleted_at IS NULL
--             AND f.metadata ? ei.namespace
--             AND f.metadata->>ei.namespace = ei.identifier)
--
-- Without these indexes, the plan degenerates into a seq scan of events for
-- every entity-scoped content listing. One partial BTREE per namespace in use
-- keeps the JOIN on an index.
CREATE INDEX IF NOT EXISTS idx_events_metadata_email
    ON public.events ((metadata->>'email'))
    WHERE metadata ? 'email';

CREATE INDEX IF NOT EXISTS idx_events_metadata_wa_jid
    ON public.events ((metadata->>'wa_jid'))
    WHERE metadata ? 'wa_jid';

CREATE INDEX IF NOT EXISTS idx_events_metadata_phone
    ON public.events ((metadata->>'phone'))
    WHERE metadata ? 'phone';

CREATE INDEX IF NOT EXISTS idx_events_metadata_slack_user_id
    ON public.events ((metadata->>'slack_user_id'))
    WHERE metadata ? 'slack_user_id';

CREATE INDEX IF NOT EXISTS idx_events_metadata_github_login
    ON public.events ((metadata->>'github_login'))
    WHERE metadata ? 'github_login';

CREATE INDEX IF NOT EXISTS idx_events_metadata_auth_user_id
    ON public.events ((metadata->>'auth_user_id'))
    WHERE metadata ? 'auth_user_id';

CREATE INDEX IF NOT EXISTS idx_events_metadata_google_contact_id
    ON public.events ((metadata->>'google_contact_id'))
    WHERE metadata ? 'google_contact_id';

-- migrate:down

DROP INDEX IF EXISTS public.idx_events_metadata_google_contact_id;
DROP INDEX IF EXISTS public.idx_events_metadata_auth_user_id;
DROP INDEX IF EXISTS public.idx_events_metadata_github_login;
DROP INDEX IF EXISTS public.idx_events_metadata_slack_user_id;
DROP INDEX IF EXISTS public.idx_events_metadata_phone;
DROP INDEX IF EXISTS public.idx_events_metadata_wa_jid;
DROP INDEX IF EXISTS public.idx_events_metadata_email;
