-- migrate:up

-- Make a connection's execution target explicit, and give every device worker
-- a home organization.
--
-- connections.device_worker_id (nullable) is the binding:
--   NULL  -> runs on the cloud connector-worker pool (today's behavior)
--   set   -> runs are pinned to that device worker
-- For device-type connectors the binding is mandatory; for cloud connectors
-- it's an optional override. A connection can only be pinned to a device that
-- is attached to that connection's organization.
--
-- device_workers.organization_id is the device's home org — chosen at setup,
-- defaulting to the owner's personal workspace. The device's connectors live
-- there; re-attaching the device to a different org (a member of which the
-- owner must be) is the only knob. There is no per-connection device→org grant.

-- Surrogate key for device_workers so connections / UI can reference a device
-- by a single stable id. The (user_id, worker_id) primary key stays.
ALTER TABLE public.device_workers
    ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS organization_id text;

CREATE UNIQUE INDEX IF NOT EXISTS device_workers_id_key
    ON public.device_workers (id);

CREATE INDEX IF NOT EXISTS idx_device_workers_organization_id
    ON public.device_workers (organization_id)
    WHERE organization_id IS NOT NULL;

ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS device_worker_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'connections_device_worker_id_fkey'
    ) THEN
        ALTER TABLE public.connections
            ADD CONSTRAINT connections_device_worker_id_fkey
            FOREIGN KEY (device_worker_id)
            REFERENCES public.device_workers (id)
            ON DELETE SET NULL;
    END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_connections_device_worker_id
    ON public.connections (device_worker_id)
    WHERE device_worker_id IS NOT NULL;

-- Attach existing devices to their owner's personal workspace (no-op on a
-- fresh database — there are no users yet; the device heartbeat sets this for
-- new devices either way).
UPDATE public.device_workers dw
SET organization_id = (
    SELECT o.id FROM public.organization o
    WHERE (o.metadata::jsonb)->>'personal_org_for_user_id' = dw.user_id
    LIMIT 1
)
WHERE dw.organization_id IS NULL;

-- Backfill: existing auto-wired personal-org device connections (created_by
-- set, no auth profile) whose owner has exactly one device get pinned to that
-- device — but at most one per (org, connector_key, owner) so the unique index
-- created below can never be violated. Ambiguous ones stay NULL and the UI
-- prompts for a device.
UPDATE public.connections c
SET device_worker_id = dw.id
FROM (
    -- Users with exactly one device worker (no min(uuid) needed — and Postgres
    -- has no aggregate for uuid anyway).
    SELECT dw1.user_id, dw1.id
    FROM public.device_workers dw1
    WHERE NOT EXISTS (
        SELECT 1 FROM public.device_workers dw2
        WHERE dw2.user_id = dw1.user_id AND dw2.id <> dw1.id
    )
) dw
WHERE c.created_by = dw.user_id
  AND c.device_worker_id IS NULL
  AND c.deleted_at IS NULL
  AND c.auth_profile_id IS NULL
  AND c.connector_key IN (
      SELECT key FROM public.connector_definitions WHERE required_capability IS NOT NULL
  )
  AND c.id = (
      SELECT min(c2.id) FROM public.connections c2
      WHERE c2.organization_id = c.organization_id
        AND c2.connector_key = c.connector_key
        AND c2.created_by = c.created_by
        AND c2.deleted_at IS NULL
  );

-- One active connection per (org, connector, device). A second device backing
-- the same connector is a second connection. Doubles as DB-level idempotency
-- for the create-vs-auto-wire race. Created AFTER the backfill above.
DROP INDEX IF EXISTS public.idx_connections_org_connector_device_live;
CREATE UNIQUE INDEX idx_connections_org_connector_device_live
    ON public.connections (organization_id, connector_key, device_worker_id)
    WHERE deleted_at IS NULL AND device_worker_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.idx_connections_org_connector_device_live;
DROP INDEX IF EXISTS public.idx_connections_device_worker_id;
ALTER TABLE public.connections
    DROP CONSTRAINT IF EXISTS connections_device_worker_id_fkey,
    DROP COLUMN IF EXISTS device_worker_id;
DROP INDEX IF EXISTS public.device_workers_id_key;
DROP INDEX IF EXISTS public.idx_device_workers_organization_id;
ALTER TABLE public.device_workers
    DROP COLUMN IF EXISTS id,
    DROP COLUMN IF EXISTS organization_id;
