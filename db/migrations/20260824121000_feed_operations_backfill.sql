-- Convert connector-definition snapshots written before feed operations became
-- explicit. The old runtime required every connector to implement sync; a
-- definition or existing feed marked virtual also had a source-read path.
-- Persisting that final capability contract keeps the new runtime strict: no
-- request-time kind/virtual fallback survives the cutover.

-- migrate:up

WITH rewritten AS (
  SELECT
    definition.id,
    jsonb_object_agg(
      entry.key,
      CASE
        WHEN jsonb_typeof(entry.value) <> 'object'
             OR entry.value ? 'operations'
          THEN entry.value
        ELSE jsonb_set(
          entry.value,
          '{operations}',
          CASE
            WHEN entry.value -> 'virtual' = 'true'::jsonb
                 OR EXISTS (
                   SELECT 1
                   FROM feeds f
                   JOIN connections c ON c.id = f.connection_id
                   WHERE f.organization_id = definition.organization_id
                     AND c.connector_key = definition.key
                     AND f.feed_key = entry.key
                     AND f.deleted_at IS NULL
                     AND f.virtual = true
                 )
              THEN '["sync", "read"]'::jsonb
            ELSE '["sync"]'::jsonb
          END,
          true
        )
      END
    ) AS feeds_schema
  FROM connector_definitions definition
  CROSS JOIN LATERAL jsonb_each(definition.feeds_schema) AS entry(key, value)
  WHERE jsonb_typeof(definition.feeds_schema) = 'object'
  GROUP BY definition.id
)
UPDATE connector_definitions definition
SET feeds_schema = rewritten.feeds_schema,
    updated_at = current_timestamp
FROM rewritten
WHERE definition.id = rewritten.id
  AND definition.feeds_schema IS DISTINCT FROM rewritten.feeds_schema;

-- migrate:down

-- A capability-era read-only feed has no representation in the previous
-- runtime except a virtual feed. Restore that persisted lifecycle before
-- removing operations so rollback never schedules a source-only feed. Hybrid
-- feeds keep their existing lifecycle because the old model cannot represent
-- both operations at once.
WITH resolved_feed_operations AS (
  SELECT f.id, definition.feed_definition -> 'operations' AS operations
  FROM feeds f
  JOIN connections c ON c.id = f.connection_id
  JOIN LATERAL (
    SELECT cd.feeds_schema -> f.feed_key AS feed_definition
    FROM connector_definitions cd
    WHERE cd.organization_id = f.organization_id
      AND cd.key = c.connector_key
      AND (
        (f.pinned_version IS NULL AND cd.status = 'active')
        OR (
          f.pinned_version IS NOT NULL
          AND (cd.version = f.pinned_version OR cd.status = 'active')
        )
      )
    ORDER BY (cd.version = f.pinned_version) DESC,
             cd.updated_at DESC,
             cd.id DESC
    LIMIT 1
  ) definition ON jsonb_typeof(definition.feed_definition) = 'object'
)
UPDATE feeds f
SET kind = 'virtual',
    virtual = true,
    schedule = NULL,
    timezone = NULL,
    next_run_at = NULL,
    checkpoint = NULL,
    updated_at = current_timestamp
FROM resolved_feed_operations resolved
WHERE f.id = resolved.id
  AND resolved.operations ? 'read'
  AND NOT resolved.operations ? 'sync';

UPDATE connector_definitions
SET feeds_schema = (
      SELECT COALESCE(
        jsonb_object_agg(
          entry.key,
          CASE
            WHEN jsonb_typeof(entry.value) = 'object'
                 AND entry.value -> 'operations' ? 'read'
                 AND NOT entry.value -> 'operations' ? 'sync'
              THEN (entry.value - 'operations') || '{"virtual": true}'::jsonb
            WHEN jsonb_typeof(entry.value) = 'object'
              THEN entry.value - 'operations'
            ELSE entry.value
          END
        ),
        '{}'::jsonb
      )
      FROM jsonb_each(connector_definitions.feeds_schema) AS entry(key, value)
    ),
    updated_at = current_timestamp
WHERE jsonb_typeof(feeds_schema) = 'object';
