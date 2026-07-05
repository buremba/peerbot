-- migrate:up

ALTER TABLE public.device_workers
  ADD COLUMN IF NOT EXISTS connector_manifests jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.device_workers.connector_manifests IS
  'Per-device metadata-only connector manifests advertised by Owletto Mac/Chrome. Map: connector_key -> {manifest_hash, received_at, manifest}. No executable code.';

-- migrate:down

ALTER TABLE public.device_workers
  DROP COLUMN IF EXISTS connector_manifests;
