-- migrate:up transaction:false

-- Drop idx_entity_relationship_types_has_auto_create: partial index the
-- identity-fact engine used to enumerate rule-bearing relationship types.
-- 20260801010000 stripped the { autoCreateWhen, ruleVersion, ruleHash } keys
-- it indexed and the engine (its only reader) plus the admin tool's
-- auto_create_when argument (its only writers) are deleted in the same
-- change, so the predicate can never match again.
--
-- CONCURRENTLY needs transaction:false and a single statement; see
-- 20260801010010 for the dbmate mechanics.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationship_types_has_auto_create;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_relationship_types_has_auto_create
    ON public.entity_relationship_types ((metadata -> 'autoCreateWhen'))
    WHERE metadata ? 'autoCreateWhen' AND deleted_at IS NULL;
