-- Hard-cut the single entity-only configuration over to named durable outputs.
-- Existing versions are converted before the retired column is dropped in this
-- same transaction. Stable-key identities gain the output name, allowing one
-- Behavior to publish several entity collections without cross-output collisions.

-- migrate:up
ALTER TABLE watcher_versions
  ADD COLUMN IF NOT EXISTS outputs jsonb;

-- A fresh install already has `outputs` in the squashed baseline. An upgrade
-- still has the retired column long enough for this one-time conversion.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'watcher_versions'
      AND column_name = 'keying_config'
  ) THEN
    EXECUTE $backfill$
      WITH legacy AS (
        SELECT
          id,
          keying_config,
          CASE
            WHEN normalized_name ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
              THEN normalized_name
            ELSE 'items'
          END AS output_name
        FROM (
          SELECT
            id,
            keying_config,
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  COALESCE(NULLIF(keying_config->>'entity_path', ''), 'items'),
                  '\[\*\]$', ''
                ),
                '^\$\.?', ''
              ),
              '^.*\.', ''
            ) AS normalized_name
          FROM watcher_versions
          WHERE outputs IS NULL
            AND keying_config IS NOT NULL
        ) candidates
      )
      UPDATE watcher_versions v
      SET outputs = jsonb_build_object(
        legacy.output_name,
        jsonb_strip_nulls(
          jsonb_build_object(
            'entity', COALESCE(
              NULLIF(legacy.keying_config->>'entity_type', ''),
              CASE
                WHEN legacy.output_name LIKE '%ies'
                  THEN regexp_replace(legacy.output_name, 'ies$', 'y')
                WHEN legacy.output_name LIKE '%s'
                     AND legacy.output_name NOT LIKE '%ss'
                  THEN regexp_replace(legacy.output_name, 's$', '')
                ELSE legacy.output_name
              END
            ),
            'key', legacy.keying_config->'key_fields',
            'name', legacy.keying_config->'name_fields'
          )
        )
      )
      FROM legacy
      WHERE v.id = legacy.id
    $backfill$;
  END IF;
END
$migration$;

WITH ranked_output AS (
  SELECT
    w.id AS watcher_id,
    output.key AS output_name,
    output.value->>'entity' AS entity_type,
    row_number() OVER (
      PARTITION BY w.id, output.value->>'entity'
      ORDER BY (v.id = w.current_version_id) DESC, v.version DESC, output.key
    ) AS preference
  FROM watchers w
  JOIN watcher_versions v
    ON v.watcher_id = COALESCE(w.watcher_group_id, w.id)
  CROSS JOIN LATERAL jsonb_each(COALESCE(v.outputs, '{}'::jsonb)) AS output
  WHERE output.value ? 'entity'
), preferred_output AS (
  SELECT watcher_id, output_name, entity_type
  FROM ranked_output
  WHERE preference = 1
), identity_moves AS (
  SELECT
    ei.id,
    preferred_output.watcher_id,
    preferred_output.output_name,
    substring(ei.identifier FROM length(preferred_output.watcher_id::text) + 3) AS stable_key
  FROM entity_identities ei
  JOIN entities e ON e.id = ei.entity_id
  JOIN entity_types et ON et.id = e.entity_type_id
  JOIN preferred_output
    ON e.metadata->>'watcher_id' = preferred_output.watcher_id::text
   AND preferred_output.entity_type = et.slug
  WHERE ei.namespace = 'watcher_key'
    AND ei.deleted_at IS NULL
    AND ei.identifier LIKE preferred_output.watcher_id::text || '::%'
    AND ei.identifier NOT LIKE preferred_output.watcher_id::text || '::' || preferred_output.output_name || '::%'
)
UPDATE entity_identities ei
SET identifier = identity_moves.watcher_id::text || '::' || identity_moves.output_name || '::' || identity_moves.stable_key
FROM identity_moves
WHERE ei.id = identity_moves.id;

ALTER TABLE watcher_versions
  DROP COLUMN IF EXISTS keying_config;

COMMENT ON COLUMN watcher_versions.outputs IS
  'Named Behavior output arrays. Values are {entity,key,name?} or {event}; schemas are derived at execution time.';

-- migrate:down
DO $migration$
BEGIN
  RAISE EXCEPTION
    '20260803140000_behavior_outputs is an irreversible hard cutover; restore from backup instead of recreating the retired API';
END
$migration$;
