-- migrate:up

-- Add a stable `slug` identity to `connections` so `lobu apply` can diff
-- connections by an immutable key instead of the mutable `display_name`.
--
-- Mirrors the existing `auth_profiles.slug` design: text slug, unique per org
-- among live rows (partial index on `deleted_at IS NULL`), generated from the
-- display name when not supplied explicitly.
--
-- Backfill MUST produce exactly what `ensureUniqueConnectionSlug` /
-- `slugifyConnectionName` in packages/server/src/utils/connections.ts would
-- generate (that file is the source of truth):
--   1. base = slugify(display_name); if empty, slugify(connector_key); if still
--      empty, the literal 'connection'. slugify = lowercase, every run of
--      non-alphanumerics -> '-', trim leading/trailing '-'.
--   2. Collisions per (organization_id) among live (`deleted_at IS NULL`) rows
--      are resolved with a deterministic numeric suffix loop: base, base-2,
--      base-3, ... assigned in ascending id order. Soft-deleted rows do not
--      participate in the unique index, so they keep their base slug freely.

ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS slug text;

-- slugify(display_name) -> slugify(connector_key) -> 'connection'
WITH base AS (
    SELECT
        c.id,
        coalesce(
            NULLIF(
                regexp_replace(
                    regexp_replace(lower(coalesce(c.display_name, '')), '[^a-z0-9]+', '-', 'g'),
                    '(^-+|-+$)', '', 'g'
                ),
                ''
            ),
            NULLIF(
                regexp_replace(
                    regexp_replace(lower(coalesce(c.connector_key, '')), '[^a-z0-9]+', '-', 'g'),
                    '(^-+|-+$)', '', 'g'
                ),
                ''
            ),
            'connection'
        ) AS base_slug
    FROM public.connections c
)
UPDATE public.connections c
SET slug = b.base_slug
FROM base b
WHERE b.id = c.id
  AND c.slug IS NULL;

-- Resolve collisions to base / base-2 / base-3 / ... in ascending id order.
-- Loops until no live (deleted_at IS NULL) duplicates remain — a re-assigned
-- `base-N` could itself collide with another row whose base slug is already
-- `base-N`, so a single pass is not enough.
--
-- This produces a deterministic, collision-free assignment with the same
-- semantics as the runtime (slugified connector_key fallback, numeric `-N`
-- suffixing). It is NOT guaranteed to be byte-identical to what
-- `ensureUniqueConnectionSlug` would pick for pathological mixed-name sets
-- (the runtime resolves in row-creation order against live DB state, which
-- pure SQL can't replay) — `packages/server/src/utils/connections.ts` is the
-- source of truth for new rows.
DO $$
DECLARE
    v_changed integer;
BEGIN
    LOOP
        WITH ranked AS (
            SELECT
                id,
                organization_id,
                slug,
                -- strip any suffix we may have appended on a prior pass so the
                -- base groups stay stable across iterations
                regexp_replace(slug, '-[0-9]+$', '') AS base_slug,
                row_number() OVER (
                    PARTITION BY organization_id, regexp_replace(slug, '-[0-9]+$', '')
                    ORDER BY id
                ) AS rn
            FROM public.connections
            WHERE deleted_at IS NULL
        ),
        target AS (
            SELECT
                id,
                CASE WHEN rn = 1 THEN base_slug ELSE base_slug || '-' || rn::text END AS desired_slug
            FROM ranked
        )
        UPDATE public.connections c
        SET slug = t.desired_slug
        FROM target t
        WHERE t.id = c.id
          AND c.slug IS DISTINCT FROM t.desired_slug;

        GET DIAGNOSTICS v_changed = ROW_COUNT;
        EXIT WHEN v_changed = 0;
    END LOOP;
END $$;

-- Guard: there must be no live-slug duplicate per org before the unique index.
DO $$
DECLARE
    v_dups integer;
BEGIN
    SELECT count(*) INTO v_dups
    FROM (
        SELECT organization_id, slug
        FROM public.connections
        WHERE deleted_at IS NULL
        GROUP BY organization_id, slug
        HAVING count(*) > 1
    ) d;
    IF v_dups > 0 THEN
        RAISE EXCEPTION 'connections.slug backfill left % duplicate (organization_id, slug) group(s) among live rows', v_dups;
    END IF;
END $$;

ALTER TABLE public.connections
    ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS connections_org_slug_unique
    ON public.connections (organization_id, slug)
    WHERE deleted_at IS NULL;

-- migrate:down

DROP INDEX IF EXISTS public.connections_org_slug_unique;
ALTER TABLE public.connections
    DROP COLUMN IF EXISTS slug;
