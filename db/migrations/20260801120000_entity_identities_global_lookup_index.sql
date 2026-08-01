-- migrate:up transaction:false

-- Index the GLOBAL (namespace, identifier) direction on entity_identities.
--
-- Chat-identity resolution ("which Lobu user is this Slack workspace user?")
-- now reads the entity graph instead of the dedicated `chat_user_identities`
-- table. That question is deliberately cross-org: one human's `$member` exists
-- once per org, and an inbound Slack event carries no org.
--
-- No existing index covers `(namespace, identifier)` without a leading
-- `organization_id` (`idx_entity_identities_live_unique` leads with it; the
-- rest key on entity_id / merged_from / connection_id), so an org-less lookup
-- could only be answered by a sequential scan. This is the supporting index
-- for it.
--
-- NOT unique, on purpose: the same external principal legitimately maps to a
-- different entity in each org, and the org-scoped unique index still enforces
-- the real invariant. The reader fails closed when a principal resolves to more
-- than one DISTINCT auth user.
--
-- CONCURRENTLY (single statement, transaction:false) so building it never locks
-- out writers during the Helm migration hook.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_global_lookup
    ON entity_identities (namespace, identifier)
    WHERE deleted_at IS NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_global_lookup;
