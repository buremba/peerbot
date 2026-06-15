-- migrate:up

-- Declared metric layer for entity types. `metrics_config` holds the entity's
-- declared metric contract — eventSets / measures / dimensions / segments (see
-- @lobu/connector-sdk metrics.ts) — stored verbatim as the author sent it.
-- The future metric compiler lowers this into backing SQL; this migration only
-- adds the storage. NULL ⇒ the type declares no metrics (not in the metric
-- catalog). Distinct from `metadata_schema` (the entity's metadata JSON Schema)
-- and from `backing_sql` (a derived type's view).
--
-- Idempotent: no-op on databases that already have the column.
ALTER TABLE public.entity_types ADD COLUMN IF NOT EXISTS metrics_config jsonb;

-- migrate:down

ALTER TABLE public.entity_types DROP COLUMN IF EXISTS metrics_config;
