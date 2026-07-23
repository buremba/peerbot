-- migrate:up

-- `attributions` replaced `entityLinks` in the connector contract. A previous
-- backfill converted definitions that existed at the time, but device manifests
-- could still publish the removed field and later overwrite those rows. Convert
-- every persisted definition again, then discard stored device manifests that
-- would otherwise re-advertise the removed contract.

DO $$
DECLARE
  def RECORD;
  feed_key text;
  feed_val jsonb;
  kind_key text;
  kind_val jsonb;
  link jsonb;
  new_attrs jsonb;
  new_kinds jsonb;
  new_feeds jsonb;
  replacement jsonb;
  changed boolean;
BEGIN
  FOR def IN
    SELECT id, feeds_schema
    FROM connector_definitions
    WHERE jsonb_typeof(feeds_schema) = 'object'
      AND jsonb_path_exists(feeds_schema, '$.*.eventKinds.*.entityLinks')
  LOOP
    new_feeds := def.feeds_schema;
    changed := false;

    FOR feed_key, feed_val IN SELECT * FROM jsonb_each(def.feeds_schema) LOOP
      IF jsonb_typeof(feed_val -> 'eventKinds') <> 'object' THEN
        CONTINUE;
      END IF;

      new_kinds := feed_val -> 'eventKinds';
      FOR kind_key, kind_val IN SELECT * FROM jsonb_each(feed_val -> 'eventKinds') LOOP
        IF jsonb_typeof(kind_val) <> 'object' OR NOT kind_val ? 'entityLinks' THEN
          CONTINUE;
        END IF;

        -- A current attribution declaration is authoritative if both fields
        -- somehow coexist. Otherwise convert every object-shaped removed rule
        -- one-for-one. Malformed legacy values are discarded so they cannot
        -- block the cleanup or survive it.
        IF jsonb_typeof(kind_val -> 'attributions') = 'array' THEN
          replacement := kind_val - 'entityLinks';
        ELSIF jsonb_typeof(kind_val -> 'entityLinks') = 'array' THEN
          new_attrs := '[]'::jsonb;
          FOR link IN SELECT * FROM jsonb_array_elements(kind_val -> 'entityLinks') LOOP
            IF jsonb_typeof(link) <> 'object' THEN
              CONTINUE;
            END IF;
            new_attrs := new_attrs || jsonb_strip_nulls(jsonb_build_object(
              'role', 'authored_by',
              'autoCreate', link -> 'autoCreate',
              'traits', link -> 'traits',
              'target', jsonb_strip_nulls(jsonb_build_object(
                'entityType', link -> 'entityType',
                'createWhen', link -> 'createWhen',
                'titlePath', link -> 'titlePath',
                'identities', link -> 'identities'
              ))
            ));
          END LOOP;
          replacement :=
            (kind_val - 'entityLinks') || jsonb_build_object('attributions', new_attrs);
        ELSE
          replacement := kind_val - 'entityLinks';
        END IF;

        new_kinds := jsonb_set(new_kinds, ARRAY[kind_key], replacement);
        changed := true;
      END LOOP;

      new_feeds := jsonb_set(new_feeds, ARRAY[feed_key, 'eventKinds'], new_kinds);
    END LOOP;

    IF changed THEN
      UPDATE connector_definitions
      SET feeds_schema = new_feeds,
          updated_at = current_timestamp
      WHERE id = def.id;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM connector_definitions
    WHERE jsonb_path_exists(feeds_schema, '$.*.eventKinds.*.entityLinks')
  ) THEN
    RAISE EXCEPTION 'connector definition still contains removed entityLinks';
  END IF;

  UPDATE device_workers dw
  SET connector_manifests = COALESCE(
    (
      SELECT jsonb_object_agg(entry.key, entry.value)
      FROM jsonb_each(dw.connector_manifests) AS entry
      WHERE NOT jsonb_path_exists(
        entry.value,
        '$.manifest.feeds_schema.*.eventKinds.*.entityLinks'
      )
    ),
    '{}'::jsonb
  )
  WHERE jsonb_typeof(dw.connector_manifests) = 'object'
    AND jsonb_path_exists(
      dw.connector_manifests,
      '$.*.manifest.feeds_schema.*.eventKinds.*.entityLinks'
    );

  IF EXISTS (
    SELECT 1
    FROM device_workers
    WHERE jsonb_path_exists(
      connector_manifests,
      '$.*.manifest.feeds_schema.*.eventKinds.*.entityLinks'
    )
  ) THEN
    RAISE EXCEPTION 'stored device manifest still contains removed entityLinks';
  END IF;
END $$;

-- migrate:down

-- Irreversible by design: the application rejects the removed contract.
SELECT 1;
