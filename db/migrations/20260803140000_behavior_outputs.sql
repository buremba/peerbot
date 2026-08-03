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

-- Only an upgrading database has the retired column. A fresh database starts
-- from the squashed baseline with exact v1 tuple identities, so never infer
-- legacy identity shape from a string prefix alone.
DO $migration$
DECLARE
  definition record;
  move record;
  key_field text;
  key_field_json jsonb;
  key_fields_seen text[];
  key_value jsonb;
  raw_value text;
  type_tag text;
  encoded_field text;
  encoded_value text;
  stable_key text;
  target_identifier text;
  existing_target_identity_id bigint;
  existing_target_entity_id bigint;
  handled_identity_ids bigint[] := ARRAY[]::bigint[];
  tombstoned_count integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'watcher_versions'
      AND column_name = 'keying_config'
  ) THEN
    -- Validate every persisted declaration before removing keying_config, even
    -- when a Behavior has not promoted an entity yet. Otherwise malformed
    -- dormant configuration would survive the cutover and fail only after its
    -- first production run.
    FOR definition IN
      SELECT
        w.id AS watcher_id,
        v.id AS version_id,
        output.key AS output_name,
        output.value->>'entity' AS entity_type,
        output.value->'key' AS key_fields
      FROM watchers w
      JOIN watcher_versions v
        ON v.watcher_id = COALESCE(w.watcher_group_id, w.id)
      CROSS JOIN LATERAL jsonb_each(COALESCE(v.outputs, '{}'::jsonb)) AS output
      WHERE output.value ? 'entity'
    LOOP
      IF definition.entity_type IS NULL
         OR length(definition.entity_type) = 0
         OR jsonb_typeof(definition.key_fields) <> 'array'
         OR jsonb_array_length(definition.key_fields) < 1
         OR jsonb_array_length(definition.key_fields) > 4 THEN
        RAISE EXCEPTION
          'Behavior output migration found invalid entity/key configuration for watcher %, version %, output %',
          definition.watcher_id, definition.version_id, definition.output_name;
      END IF;

      key_fields_seen := ARRAY[]::text[];
      FOR key_field_json IN SELECT value FROM jsonb_array_elements(definition.key_fields)
      LOOP
        IF jsonb_typeof(key_field_json) <> 'string' THEN
          RAISE EXCEPTION
            'Behavior output migration found a non-string key field for watcher %, version %, output %',
            definition.watcher_id, definition.version_id, definition.output_name;
        END IF;
        key_field := key_field_json #>> '{}';
        IF key_field = ANY(key_fields_seen)
           OR length(key_field) < 1
           OR length(key_field) > 128 THEN
          RAISE EXCEPTION
            'Behavior output migration found an invalid or duplicate key field for watcher %, version %, output %',
            definition.watcher_id, definition.version_id, definition.output_name;
        END IF;
        key_fields_seen := array_append(key_fields_seen, key_field);
      END LOOP;
    END LOOP;

    -- Re-key every live legacy claim that still belongs to the Behavior's
    -- current entity outputs, using the entity's RAW key fields. Historical
    -- version declarations remain readable but do not keep retired claims live.
    -- The v1 tuple is exact and typed:
    -- base64url(field).type.base64url(value), joined
    -- in declaration order. This avoids the retired lossy slug key, where
    -- distinct opaque ids such as ACME/1 and ACME1 collided. Fail closed on any
    -- row that cannot be represented rather than dropping the old API and
    -- silently creating duplicates on the next Behavior run.
    FOR move IN
      WITH ranked_output AS (
        SELECT
          w.id AS watcher_id,
          output.key AS output_name,
          output.value->>'entity' AS entity_type,
          output.value->'key' AS key_fields,
          row_number() OVER (
            PARTITION BY w.id, output.value->>'entity'
            ORDER BY output.key
          ) AS preference
        FROM watchers w
        JOIN watcher_versions v
          ON v.id = w.current_version_id
        CROSS JOIN LATERAL jsonb_each(COALESCE(v.outputs, '{}'::jsonb)) AS output
        WHERE w.status <> 'archived'
          AND output.value ? 'entity'
      ), preferred_output AS (
        SELECT watcher_id, output_name, entity_type, key_fields
        FROM ranked_output
        WHERE preference = 1
      )
      SELECT
        ei.id AS identity_id,
        ei.organization_id,
        ei.entity_id,
        ei.identifier AS current_identifier,
        preferred_output.watcher_id,
        preferred_output.output_name,
        preferred_output.key_fields,
        e.metadata
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      JOIN entity_types et ON et.id = e.entity_type_id
      JOIN preferred_output
        ON e.metadata->>'watcher_id' = preferred_output.watcher_id::text
       AND preferred_output.entity_type = et.slug
      WHERE ei.namespace = 'watcher_key'
        AND ei.deleted_at IS NULL
        AND ei.identifier LIKE preferred_output.watcher_id::text || '::%'
      ORDER BY ei.id
    LOOP
      IF jsonb_typeof(move.key_fields) <> 'array'
         OR jsonb_array_length(move.key_fields) < 1
         OR jsonb_array_length(move.key_fields) > 4 THEN
        RAISE EXCEPTION
          'Behavior output identity migration found invalid key fields for watcher %, entity %',
          move.watcher_id, move.entity_id;
      END IF;

      key_fields_seen := ARRAY[]::text[];
      stable_key := 'v1';
      FOR key_field IN SELECT jsonb_array_elements_text(move.key_fields)
      LOOP
        IF key_field = ANY(key_fields_seen)
           OR length(key_field) < 1
           OR length(key_field) > 128 THEN
          RAISE EXCEPTION
            'Behavior output identity migration found an invalid or duplicate key field for watcher %, entity %',
            move.watcher_id, move.entity_id;
        END IF;
        key_fields_seen := array_append(key_fields_seen, key_field);
        key_value := move.metadata -> key_field;
        raw_value := move.metadata ->> key_field;

        CASE jsonb_typeof(key_value)
          WHEN 'string' THEN
            IF length(btrim(raw_value)) = 0 OR octet_length(raw_value) > 256 THEN
              RAISE EXCEPTION
                'Behavior output identity migration found an invalid string key value for watcher %, entity %, field %',
                move.watcher_id, move.entity_id, key_field;
            END IF;
            type_tag := 's';
          WHEN 'number' THEN
            IF raw_value !~ '^-?(0|[1-9][0-9]*)$'
               OR raw_value::numeric < -9007199254740991
               OR raw_value::numeric > 9007199254740991 THEN
              RAISE EXCEPTION
                'Behavior output identity migration found a non-safe-integer key value for watcher %, entity %, field %',
                move.watcher_id, move.entity_id, key_field;
            END IF;
            type_tag := 'i';
          WHEN 'boolean' THEN
            type_tag := 'b';
          ELSE
            RAISE EXCEPTION
              'Behavior output identity migration found a missing, null, or non-scalar key value for watcher %, entity %, field %',
              move.watcher_id, move.entity_id, key_field;
        END CASE;

        encoded_field := translate(
          rtrim(replace(encode(convert_to(key_field, 'UTF8'), 'base64'), E'\n', ''), '='),
          '+/', '-_'
        );
        encoded_value := translate(
          rtrim(replace(encode(convert_to(raw_value, 'UTF8'), 'base64'), E'\n', ''), '='),
          '+/', '-_'
        );
        stable_key := stable_key || '~' || encoded_field || '.' || type_tag || '.' || encoded_value;
      END LOOP;

      target_identifier := move.watcher_id::text || '::' ||
        move.output_name || '::' || stable_key;
      IF move.current_identifier = target_identifier THEN
        handled_identity_ids := array_append(handled_identity_ids, move.identity_id);
      ELSE
        SELECT existing.id, existing.entity_id
        INTO existing_target_identity_id, existing_target_entity_id
        FROM entity_identities existing
        WHERE existing.organization_id = move.organization_id
          AND existing.namespace = 'watcher_key'
          AND existing.identifier = target_identifier
          AND existing.deleted_at IS NULL
          AND existing.id <> move.identity_id
        LIMIT 1;

        IF existing_target_identity_id IS NOT NULL THEN
          IF existing_target_entity_id <> move.entity_id THEN
            RAISE EXCEPTION
              'Behavior output identity migration would collide with an existing live watcher_key for watcher %, entity %',
              move.watcher_id, move.entity_id;
          END IF;
          UPDATE entity_identities
          SET deleted_at = current_timestamp
          WHERE id = move.identity_id;
          handled_identity_ids := array_append(
            handled_identity_ids,
            existing_target_identity_id
          );
        ELSE
          UPDATE entity_identities
          SET identifier = target_identifier
          WHERE id = move.identity_id;
          handled_identity_ids := array_append(handled_identity_ids, move.identity_id);
        END IF;
      END IF;

      UPDATE entities
      SET metadata = metadata || jsonb_build_object(
        'stable_key', stable_key,
        'behavior_output', move.output_name
      )
      WHERE id = move.entity_id;
    END LOOP;

    -- A removed/entity-less output has no valid identity namespace in the new
    -- contract. Retire every legacy claim that could not be mapped instead of
    -- leaving a live two-part key that the new runtime can never recognize.
    -- The promoted entity itself remains intact and auditable.
    UPDATE entity_identities
    SET deleted_at = current_timestamp
    WHERE namespace = 'watcher_key'
      AND deleted_at IS NULL
      AND NOT (id = ANY(handled_identity_ids));
    GET DIAGNOSTICS tombstoned_count = ROW_COUNT;
    IF tombstoned_count > 0 THEN
      RAISE NOTICE
        'Behavior output migration retired % unmapped legacy watcher_key identities',
        tombstoned_count;
    END IF;
  END IF;
END
$migration$;

ALTER TABLE watcher_versions
  DROP COLUMN IF EXISTS keying_config;

-- Behavior event outputs may now represent a durable reply draft linked under
-- its source event. Existing orgs commonly have an explicit $member allowlist,
-- so add the newly built-in kind without overwriting an org-authored definition
-- (or materializing a NULL, permissive registry).
UPDATE entity_types
SET event_kinds = jsonb_build_object(
      'draft_reply',
      jsonb_build_object(
        'description', 'A reply draft linked to the source event it responds to',
        'metadataSchema', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'confidence', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
            'importance', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
            'namespace', jsonb_build_object('type', 'string'),
            'status', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('active', 'archived', 'deleted')
            ),
            'platform', jsonb_build_object('type', 'string'),
            'author', jsonb_build_object('type', 'string'),
            'why', jsonb_build_object('type', 'string'),
            'priority', jsonb_build_object(
              'type', 'string',
              'enum', jsonb_build_array('low', 'normal', 'high')
            ),
            'source_origin_id', jsonb_build_object('type', 'string'),
            'source_event_id', jsonb_build_object('type', 'integer', 'minimum', 1),
            'source_connection_id', jsonb_build_object('type', 'integer', 'minimum', 1)
          )
        )
      )
    ) || event_kinds,
    updated_at = current_timestamp
WHERE slug = '$member'
  AND deleted_at IS NULL
  AND event_kinds IS NOT NULL
  AND NOT (event_kinds ? 'draft_reply');

COMMENT ON COLUMN watcher_versions.outputs IS
  'Named Behavior output arrays. Values are {entity,key,name?} or {event}; schemas are derived at execution time.';

-- migrate:down
DO $migration$
BEGIN
  RAISE EXCEPTION
    '20260803140000_behavior_outputs is an irreversible hard cutover; restore from backup instead of recreating the retired API';
END
$migration$;
