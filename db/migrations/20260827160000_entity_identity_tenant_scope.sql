-- migrate:up transaction:false

-- Identity scope belongs to the upstream tenant/account/database, not to a
-- Lobu `connections` row. Reconnecting may mint a new connection id, while two
-- connections can legitimately address the same upstream tenant. The connector
-- therefore supplies a stable text scope key from each event.
ALTER TABLE public.entity_identities
  ADD COLUMN IF NOT EXISTS scope_key text;

-- #2846 shipped the connection-shaped column before a production connector
-- adopted it. Refuse to guess a tenant key if that assumption is ever false.
DO $scope_guard$
DECLARE
  has_scoped_rows boolean;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'entity_identities'
      AND column_name = 'scope_connection_id'
  ) THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.entity_identities WHERE scope_connection_id IS NOT NULL
    )' INTO has_scoped_rows;

    IF has_scoped_rows THEN
      RAISE EXCEPTION USING
        MESSAGE = 'entity identity tenant-scope migration refused: scope_connection_id contains non-NULL rows',
        HINT = 'Re-key those identities explicitly before retrying the migration.';
    END IF;
  END IF;
END
$scope_guard$;

-- A crashed concurrent build leaves an INVALID same-named index. Heal it on a
-- retry so IF NOT EXISTS cannot record a non-enforcing arbiter as success.
DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_entity_identities_live_unique_tenant_scoped'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entity_identities_live_unique_tenant_scoped';
  END IF;
END
$heal$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_live_unique_tenant_scoped
  ON public.entity_identities (organization_id, namespace, identifier, COALESCE(scope_key, ''))
  WHERE deleted_at IS NULL;

-- Durable current + pending declaration shape. A blocked apply records the
-- exact shape the explicit re-key command must promote with the row rewrite.
CREATE TABLE IF NOT EXISTS public.connector_identity_scope_registry (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  connector_key text NOT NULL,
  namespace text NOT NULL,
  scope text NOT NULL,
  scope_key_path text,
  pending_scope text,
  pending_scope_key_path text,
  shape_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_identity_scope_registry_pkey
    PRIMARY KEY (organization_id, connector_key, namespace),
  CONSTRAINT connector_identity_scope_registry_shape_check CHECK (
    (scope = 'organization' AND scope_key_path IS NULL)
    OR
    (scope = 'tenant' AND length(btrim(scope_key_path)) > 0)
  ),
  CONSTRAINT connector_identity_scope_registry_pending_shape_check CHECK (
    (pending_scope IS NULL AND pending_scope_key_path IS NULL)
    OR
    (pending_scope = 'organization' AND pending_scope_key_path IS NULL)
    OR
    (pending_scope = 'tenant' AND length(btrim(pending_scope_key_path)) > 0)
  )
);

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_live_unique_scoped;

-- squawk-ignore ban-drop-column -- #2846 was unadopted; the guard above proves there is no scoped data to preserve
ALTER TABLE public.entity_identities
  DROP COLUMN IF EXISTS scope_connection_id;

-- migrate:down transaction:false

ALTER TABLE public.entity_identities
  ADD COLUMN IF NOT EXISTS scope_connection_id bigint;

DO $scope_guard_down$
DECLARE
  has_scoped_rows boolean;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'entity_identities'
      AND column_name = 'scope_key'
  ) THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.entity_identities WHERE scope_key IS NOT NULL
    )' INTO has_scoped_rows;

    IF has_scoped_rows THEN
      RAISE EXCEPTION USING
        MESSAGE = 'entity identity tenant-scope rollback refused: scope_key contains non-NULL rows',
        HINT = 'Re-key those identities to organization scope before retrying the rollback.';
    END IF;
  END IF;
END
$scope_guard_down$;

DO $heal_down$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_entity_identities_live_unique_scoped'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.idx_entity_identities_live_unique_scoped';
  END IF;
END
$heal_down$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_identities_live_unique_scoped
  ON public.entity_identities (organization_id, namespace, identifier, COALESCE(scope_connection_id, 0))
  WHERE deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_identities_live_unique_tenant_scoped;

-- squawk-ignore ban-drop-table -- rollback path for the registry introduced above
DROP TABLE IF EXISTS public.connector_identity_scope_registry;

-- squawk-ignore ban-drop-column -- rollback path for the column introduced above
ALTER TABLE public.entity_identities
  DROP COLUMN IF EXISTS scope_key;
