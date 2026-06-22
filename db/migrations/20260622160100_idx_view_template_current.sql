-- migrate:up transaction:false

-- One current named-tab version per (resource, tab). Partial: excludes the
-- default-tab rows (tab_name NULL — those track current via the parent FK
-- current_view_template_version_id, not is_current). CONCURRENTLY since
-- view_template_versions is read on the entity-detail path; the partial predicate
-- keeps it tiny. squawk-ignore prefer-robust-stmts
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_view_template_versions_current
    ON public.view_template_versions (resource_type, resource_id, organization_id, tab_name)
    WHERE is_current = true AND tab_name IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_view_template_versions_current;
