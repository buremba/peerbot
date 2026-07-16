-- migrate:up transaction:false

-- Index the FK referencing side: entity_identities.connection_id →
-- connections(id). Postgres does not auto-index the referencing side, so
-- deleting a connections row would seq-scan (and lock) entity_identities.
-- Built CONCURRENTLY so it only takes SHARE UPDATE EXCLUSIVE and reads + writes
-- continue. One statement per transaction:false migration: dbmate sends the up
-- block as a single simple-query batch and Postgres wraps any multi-statement
-- batch in an implicit transaction that CONCURRENTLY refuses to run inside.
-- The CONCURRENTLY + IF NOT EXISTS invalid-index trap recovery is in
-- docs/MIGRATIONS.md.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_connection_id
    ON public.entity_identities (connection_id);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_connection_id;
