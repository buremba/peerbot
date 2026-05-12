-- migrate:up

-- Add a stable `slug` identity to `connections` so `lobu apply` can diff
-- connections by an immutable key instead of the mutable `display_name`.
--
-- Mirrors the existing `auth_profiles.slug` design: text slug, unique per org
-- among live rows (partial index on `deleted_at IS NULL`), generated from the
-- display name when not supplied explicitly.
--
-- Backfill rules (kept in sync with `slugifyConnectionName` /
-- `ensureUniqueConnectionSlug` in packages/server/src/utils/connections.ts):
--   1. slugify(display_name): lowercase, every run of non-alphanumerics → `-`,
--      trim leading/trailing `-`.
--   2. On an empty result, fall back to `connector_key || '-' || id`.
--   3. On a duplicate (per organization), fall back to `connector_key || '-' || id`
--      for the losing rows. Live rows win the clean slug over soft-deleted ones.

ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS slug text;

WITH base AS (
    SELECT
        c.id,
        c.organization_id,
        c.connector_key,
        c.deleted_at,
        NULLIF(
            regexp_replace(
                regexp_replace(lower(coalesce(c.display_name, '')), '[^a-z0-9]+', '-', 'g'),
                '(^-+|-+$)', '', 'g'
            ),
            ''
        ) AS slug_from_name
    FROM public.connections c
),
candidates AS (
    SELECT
        b.id,
        b.organization_id,
        b.connector_key,
        coalesce(b.slug_from_name, b.connector_key || '-' || b.id::text) AS candidate,
        row_number() OVER (
            PARTITION BY b.organization_id, coalesce(b.slug_from_name, b.connector_key || '-' || b.id::text)
            ORDER BY (b.deleted_at IS NOT NULL), b.id
        ) AS rn
    FROM base b
)
UPDATE public.connections c
SET slug = CASE
        WHEN cand.rn = 1 THEN cand.candidate
        ELSE cand.connector_key || '-' || cand.id::text
    END
FROM candidates cand
WHERE cand.id = c.id
  AND c.slug IS NULL;

-- Final guard: a `connector_key || '-' || id` fallback could in theory collide
-- with another row's clean slug. The partial unique index below would reject
-- that, so make any remaining intra-org live-slug duplicates unique by id.
WITH dups AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY organization_id, slug
            ORDER BY (deleted_at IS NOT NULL), id
        ) AS rn
    FROM public.connections
)
UPDATE public.connections c
SET slug = c.slug || '-' || c.id::text
FROM dups
WHERE dups.id = c.id
  AND dups.rn > 1;

ALTER TABLE public.connections
    ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS connections_org_slug_unique
    ON public.connections (organization_id, slug)
    WHERE deleted_at IS NULL;

-- migrate:down

DROP INDEX IF EXISTS public.connections_org_slug_unique;
ALTER TABLE public.connections
    DROP COLUMN IF EXISTS slug;
