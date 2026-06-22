-- migrate:up transaction:false

-- Routing lookup for the shared webhook endpoint, which carries no org context:
-- resolve the install by the provider tenant tuple alone. Covers both the active
-- resolution (status='active' rows are a subset of this) and admin/listing reads
-- across statuses. CONCURRENTLY so the build never blocks installs; one statement
-- per transaction:false migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS app_installations_route
    ON public.app_installations (provider, provider_instance, provider_app_id, external_tenant_id);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.app_installations_route;
