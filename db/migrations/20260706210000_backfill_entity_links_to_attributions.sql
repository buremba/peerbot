-- migrate:up

-- Backfill persisted connector definitions from the legacy `entityLinks` shape
-- to the `attributions` shape the identity-pipeline bridge now reads.
--
-- `feeds_schema` is a JSONB snapshot written at install time and only re-synced
-- for BUNDLED connectors (via the refresh-connector-definitions cron). File- or
-- catalog-installed connectors are never re-synced, so a row written before this
-- migration keeps `eventKinds[kind].entityLinks[]` forever — and the new loader
-- reads only `attributions`, silently dropping all attribution for that install.
-- This converts every such row in place so `entityLinks` disappears from data as
-- well as code, with no read-time compatibility shim.
--
-- Per rule: entityLinks[i] { entityType, autoCreate, createWhen, titlePath,
-- identities, traits } → attributions[i] { role: 'authored_by', autoCreate,
-- traits, target: { entityType, createWhen, titlePath, identities } }.
-- `role` is not present in the legacy shape; the resolver does not yet consume
-- it, so 'authored_by' is the neutral default (matches the test bridge).

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
  changed boolean;
BEGIN
  FOR def IN
    SELECT id, feeds_schema
    FROM connector_definitions
    WHERE feeds_schema IS NOT NULL
      AND feeds_schema::text LIKE '%entityLinks%'
  LOOP
    new_feeds := def.feeds_schema;
    changed := false;

    FOR feed_key, feed_val IN SELECT * FROM jsonb_each(def.feeds_schema) LOOP
      IF jsonb_typeof(feed_val -> 'eventKinds') <> 'object' THEN
        CONTINUE;
      END IF;

      new_kinds := feed_val -> 'eventKinds';

      FOR kind_key, kind_val IN SELECT * FROM jsonb_each(feed_val -> 'eventKinds') LOOP
        IF jsonb_typeof(kind_val -> 'entityLinks') <> 'array' THEN
          CONTINUE;
        END IF;

        new_attrs := '[]'::jsonb;
        FOR link IN SELECT * FROM jsonb_array_elements(kind_val -> 'entityLinks') LOOP
          new_attrs := new_attrs || jsonb_build_object(
            'role', 'authored_by',
            'autoCreate', link -> 'autoCreate',
            'traits', link -> 'traits',
            'target', jsonb_strip_nulls(jsonb_build_object(
              'entityType', link -> 'entityType',
              'createWhen', link -> 'createWhen',
              'titlePath', link -> 'titlePath',
              'identities', link -> 'identities'
            ))
          );
        END LOOP;

        -- Replace entityLinks with attributions on this kind; strip a null
        -- autoCreate/traits so the rewritten JSON matches a freshly-compiled one.
        new_kinds := jsonb_set(
          new_kinds,
          ARRAY[kind_key],
          jsonb_strip_nulls((kind_val - 'entityLinks') || jsonb_build_object('attributions', new_attrs))
        );
        changed := true;
      END LOOP;

      new_feeds := jsonb_set(new_feeds, ARRAY[feed_key, 'eventKinds'], new_kinds);
    END LOOP;

    IF changed THEN
      UPDATE connector_definitions
      SET feeds_schema = new_feeds,
          updated_at = NOW()
      WHERE id = def.id;
    END IF;
  END LOOP;
END $$;

-- migrate:down

-- Irreversible: the legacy entityLinks shape is dropped from both code and data.
-- A down migration would have to re-synthesize entityLinks from attributions,
-- which is lossy (role is discarded) and pointless — no code reads entityLinks.
SELECT 1;
