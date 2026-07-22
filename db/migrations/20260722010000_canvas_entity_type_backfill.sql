-- migrate:up

-- Canvas entities could bind to an unrelated entity type.
--
-- `ensureCanvasEntity` needs an entity_type_id (the column is NOT NULL). It
-- looked for a type with slug 'canvas' and, finding none, fell back to "any
-- stored type in the org, lowest id first". Lobu does not provision that type,
-- so most orgs took the fallback; the lowest-id type is commonly `$member`,
-- which is provisioned early. Those canvas entities were typed as workspace
-- Members: they showed up in the member roster and inherited `$member`'s access
-- policy (member-list visibility and email hiding).
--
-- The code now creates and binds a built-in `$canvas` type. This backfill moves
-- the already-mislabeled rows onto it. Canvas entities are identified by
-- a live `watcher_canvas` identity claim, the authoritative per-watcher canvas
-- identity used by `ensureCanvasEntity`.
--
-- `events` is untouched: entity_ids still point at the same entity ids, only the
-- entity's type binding changes.

-- 1. Ensure a `$canvas` type exists for every org that has canvas entities.
--    Mirrors the on-demand insert in ensureCanvasEntity.
INSERT INTO public.entity_types (
  slug, name, description, icon, organization_id, created_at, updated_at
)
SELECT DISTINCT
  '$canvas', 'Canvas', 'Per-Behavior canvas window', 'layout',
  e.organization_id, current_timestamp, current_timestamp
FROM public.entities e
JOIN public.entity_identities ei
  ON ei.entity_id = e.id
 AND ei.organization_id = e.organization_id
 AND ei.namespace = 'watcher_canvas'
 AND ei.deleted_at IS NULL
WHERE e.deleted_at IS NULL
ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
DO NOTHING;

-- 2. Repoint canvas entities at their org's `$canvas` type.
UPDATE public.entities e
SET entity_type_id = ct.id,
    updated_at = current_timestamp
FROM public.entity_types ct
WHERE ct.slug = '$canvas'
  AND ct.organization_id = e.organization_id
  AND ct.deleted_at IS NULL
  AND e.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.entity_identities ei
    WHERE ei.entity_id = e.id
      AND ei.organization_id = e.organization_id
      AND ei.namespace = 'watcher_canvas'
      AND ei.deleted_at IS NULL
  )
  AND e.entity_type_id IS DISTINCT FROM ct.id;

-- migrate:down

-- Irreversible by design: the prior binding varied by org and this migration
-- does not record it, so there is nothing faithful to restore. Rolling back the
-- code is safe on its own —
-- ensureCanvasEntity's reuse fast-path resolves canvases by their
-- `watcher_canvas` identity claim, not by entity type.
SELECT 1;
