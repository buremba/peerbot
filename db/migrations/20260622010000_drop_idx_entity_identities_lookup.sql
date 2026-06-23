-- migrate:up transaction:false

-- Drop idx_entity_identities_lookup: a plain btree on entity_identities over
-- (organization_id, namespace, identifier) WHERE (deleted_at IS NULL) that is
-- byte-identical — same columns, same partial predicate — to the UNIQUE index
-- idx_entity_identities_live_unique on the same table. The unique index serves
-- every lookup the plain one did, so the plain one is pure write + disk
-- overhead. Redundancy is structural, independent of usage stats.
--
-- CONCURRENTLY (transaction:false, single statement) so the catalog drop never
-- contends with readers/writers of entity_identities during the Helm hook. One
-- statement per transaction:false migration: dbmate sends the whole up block as
-- one simple-query batch and Postgres wraps a multi-statement batch in an
-- implicit transaction that CONCURRENTLY refuses to run inside.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_lookup;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_lookup
    ON public.entity_identities USING btree (organization_id, namespace, identifier)
    WHERE (deleted_at IS NULL);
