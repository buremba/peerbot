-- migrate:up transaction:false

-- Partial BTREE on events.metadata->>'github_user_id', mirroring the existing
-- idx_events_metadata_<ns> indexes (email/phone/wa_jid/github_login/…). Required
-- for read-time entity attribution to key on the IMMUTABLE github_user_id: the
-- entityLinkMatchSql UNION emits a per-namespace branch that probes events via
-- this index, so without it the github_user_id branch would seq-scan the events
-- table. CONCURRENTLY (transaction:false, single statement) so the build never
-- blocks event ingestion. See packages/server/src/utils/content-search/entity-link.ts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_metadata_github_user_id
    ON public.events (((metadata ->> 'github_user_id'::text)))
    WHERE (metadata ? 'github_user_id'::text);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_metadata_github_user_id;
