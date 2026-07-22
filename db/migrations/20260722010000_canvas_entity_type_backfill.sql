-- migrate:up

-- Canvas entities were binding to an arbitrary entity type.
--
-- `ensureCanvasEntity` needs an entity_type_id (the column is NOT NULL). It
-- looked for a type with slug 'canvas' and, finding none, fell back to "any
-- stored type in the org, lowest id first". Nothing in the product ever creates
-- a canvas type, so that fallback was the ONLY path in every org — and the
-- lowest-id type is normally `$member`, which is provisioned first. So every
-- canvas entity was typed as a workspace Member: it showed up in the member
-- roster and inherited `$member`'s access policy (member-list visibility and
-- email hiding).
--
-- The code now creates and binds a built-in `$canvas` type. This backfill moves
-- the already-mislabeled rows onto it. Canvas entities are identified by
-- metadata->>'source' = 'watcher_canvas', which `ensureCanvasEntity` has always
-- written, so the selection is exact rather than name-matched.
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
WHERE e.metadata->>'source' = 'watcher_canvas'
  AND e.deleted_at IS NULL
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
  AND e.metadata->>'source' = 'watcher_canvas'
  AND e.deleted_at IS NULL
  AND e.entity_type_id IS DISTINCT FROM ct.id;

-- migrate:down

-- Irreversible by design: the pre-migration binding was an arbitrary
-- lowest-id type that differed per org and was never recorded, so there is
-- nothing faithful to restore. Rolling back the code is safe on its own —
-- ensureCanvasEntity's reuse fast-path resolves canvases by their
-- `watcher_canvas` identity claim, not by entity type.
SELECT 1;
