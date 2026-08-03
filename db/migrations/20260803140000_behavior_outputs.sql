-- Replace the single entity-only keying_config with named durable outputs.
-- The object key is the extracted_data top-level array, so entity_path and the
-- model-visible key_output_field disappear. Existing stable-key identities are
-- renamed to include the output name, allowing one Behavior to publish several
-- entity collections without cross-output key collisions.

-- migrate:up
ALTER TABLE watcher_versions
  ADD COLUMN IF NOT EXISTS outputs jsonb;

-- A fresh install already has `outputs` in the squashed baseline, while an
-- upgrade still has `keying_config`. Keep the backfill parse-safe for both.
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

-- Keep the legacy database column for one rolling-deploy interval. It is no
-- longer read or written by the application and is absent from the public API;
-- a later migration may drop it after every old replica is gone.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'watcher_versions'
      AND column_name = 'keying_config'
  ) THEN
    EXECUTE $comment$
      COMMENT ON COLUMN watcher_versions.keying_config IS
        'Deprecated internal column retained temporarily for rolling-deploy safety; use outputs.'
    $comment$;
  END IF;
END
$migration$;

COMMENT ON COLUMN watcher_versions.outputs IS
  'Named Behavior output arrays. Values are {entity,key,name?} or {event}; schemas are derived at execution time.';

-- migrate:down
ALTER TABLE watcher_versions
  ADD COLUMN IF NOT EXISTS keying_config jsonb;

WITH migrated AS (
  SELECT v.id, jsonb_strip_nulls(jsonb_build_object(
    'entity_type', output.value->>'entity',
    'entity_path', output.key,
    'key_fields', output.value->'key',
    'key_output_field', '_lobu_stable_key',
    'name_fields', output.value->'name'
  )) AS keying_config
  FROM watcher_versions v
  CROSS JOIN LATERAL jsonb_each(COALESCE(v.outputs, '{}'::jsonb)) AS output
  WHERE output.value ? 'entity'
    AND output.key = (
      SELECT min(candidate.key)
      FROM jsonb_each(COALESCE(v.outputs, '{}'::jsonb)) AS candidate
      WHERE candidate.value ? 'entity'
    )
)
UPDATE watcher_versions v
SET keying_config = migrated.keying_config
FROM migrated
WHERE v.id = migrated.id
  AND v.keying_config IS NULL;

ALTER TABLE watcher_versions
  DROP COLUMN IF EXISTS outputs;
