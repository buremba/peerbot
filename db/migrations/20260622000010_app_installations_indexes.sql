-- migrate:up transaction:false

-- Active-ownership invariant: at most ONE active install per external tenant
-- tuple. This partial unique index is the source of truth for the reject/
-- transfer rule — the store's upsert relies on it so concurrent callers across
-- replicas converge to a single active owner with no in-memory coordination.
-- CONCURRENTLY so the build never blocks installs on a populated table; one
-- statement per transaction:false migration (dbmate sends the block as one
-- simple-query batch and CONCURRENTLY can't run inside the implicit transaction
-- a multi-statement batch gets).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS app_installations_active_tenant
    ON public.app_installations (provider, provider_instance, provider_app_id, external_tenant_id)
    WHERE status = 'active';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.app_installations_active_tenant;
