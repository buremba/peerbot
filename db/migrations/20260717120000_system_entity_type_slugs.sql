-- migrate:up

-- Platform system types use a `$` slug prefix (users cannot create `$…`).
--
-- All ACL access units share ONE entity type: $resource (was channel / repo /
-- $channel / $repo). Sources are distinguished by identity namespace, not type.
-- $member is unchanged.

-- 1) Per org: promote one legacy ACL type row to $resource (if $resource missing).
UPDATE public.entity_types et
SET
  slug = '$resource',
  name = 'Resource',
  description = 'ACL-gated access unit (Slack channel, GitHub repository, …). Graph anchor only — empty metadata schema.',
  icon = COALESCE(NULLIF(et.icon, ''), 'shield'),
  updated_at = current_timestamp
WHERE et.deleted_at IS NULL
  AND et.slug IN ('channel', 'repo', '$channel', '$repo')
  AND et.id = (
    SELECT et2.id
    FROM public.entity_types et2
    WHERE et2.organization_id IS NOT DISTINCT FROM et.organization_id
      AND et2.deleted_at IS NULL
      AND et2.slug IN ('channel', 'repo', '$channel', '$repo')
    ORDER BY
      CASE et2.slug
        WHEN '$channel' THEN 1
        WHEN 'channel' THEN 2
        WHEN '$repo' THEN 3
        WHEN 'repo' THEN 4
        ELSE 9
      END,
      et2.id
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.entity_types x
    WHERE x.organization_id IS NOT DISTINCT FROM et.organization_id
      AND x.slug = '$resource'
      AND x.deleted_at IS NULL
  );

-- 2) Point every entity still on a legacy ACL type at the org's $resource type.
UPDATE public.entities e
SET
  entity_type_id = r.id,
  updated_at = current_timestamp
FROM public.entity_types old
JOIN public.entity_types r
  ON r.organization_id IS NOT DISTINCT FROM old.organization_id
 AND r.slug = '$resource'
 AND r.deleted_at IS NULL
WHERE e.entity_type_id = old.id
  AND e.deleted_at IS NULL
  AND old.deleted_at IS NULL
  AND old.slug IN ('channel', 'repo', '$channel', '$repo');

-- 3) Soft-delete leftover legacy ACL type rows (entities already re-pointed).
UPDATE public.entity_types
SET
  deleted_at = current_timestamp,
  updated_at = current_timestamp
WHERE deleted_at IS NULL
  AND slug IN ('channel', 'repo', '$channel', '$repo');

-- migrate:down

-- Best-effort reverse: rename $resource back to channel when no bare channel exists.
-- Multi-source orgs that had both channel and repo cannot be fully restored.
UPDATE public.entity_types et
SET
  slug = 'channel',
  name = 'Channel',
  updated_at = current_timestamp
WHERE et.slug = '$resource'
  AND et.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.entity_types x
    WHERE x.organization_id IS NOT DISTINCT FROM et.organization_id
      AND x.slug = 'channel'
      AND x.deleted_at IS NULL
  );
