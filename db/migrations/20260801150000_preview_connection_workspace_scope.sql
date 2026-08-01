-- migrate:up transaction:false

-- `previewMode` is the hosted-bot identity. The bot's real workspace may be
-- persisted in external_tenant_id for delivery scoping and ACL verification, so
-- tenantlessness cannot define or protect the global preview slot. Build the
-- stronger index before dropping the legacy tenantless-only index: if a second
-- preview connection exists, the migration fails closed and the old protection
-- remains in place.
--
-- Heal an INVALID carcass inline so every retry can rebuild it. PostgreSQL
-- considers an INVALID index to exist, which makes CREATE ... IF NOT EXISTS a
-- silent no-op after a failed concurrent build.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'uniq_preview_connection_per_platform_all'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.uniq_preview_connection_per_platform_all';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_preview_connection_per_platform_all
    ON public.connections (connector_key)
    WHERE config -> 'settings' -> 'previewMode' = 'true'::jsonb
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.uniq_preview_connection_per_platform_conn;

-- migrate:down transaction:false

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'uniq_preview_connection_per_platform_conn'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.uniq_preview_connection_per_platform_conn';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_preview_connection_per_platform_conn
    ON public.connections (connector_key)
    WHERE config -> 'settings' -> 'previewMode' = 'true'::jsonb
      AND external_tenant_id IS NULL
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.uniq_preview_connection_per_platform_all;
