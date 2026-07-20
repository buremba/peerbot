-- migrate:up

-- Repair classifier `attribute_values` that were persisted as a JSON ARRAY
-- instead of the expected object-MAP keyed by value string (#2033 item 4).
--
-- The read-side `stripEmbeddingsFromAttributeValues` fed such arrays straight
-- into Object.entries, minting numeric keys `{"0":…}` and — once elements only
-- carried `embedding` — the corrupted `{"0":{},"1":{}}` that `generate_embeddings`
-- then re-persisted. The read guard now REJECTS array roots so no NEW corruption
-- lands; this migration heals data already at rest.
--
-- Recovery rule (per array element, an ExtractedValue-shaped object
-- `{value, description?, examples?, embedding?}`):
--   * key  = element->>'value' (the sole stable identity for the value)
--   * body = the element MINUS `value` and `embedding` (embedding is
--            regenerable via generate_embeddings; value became the key)
-- Elements with no usable `value` are dropped. If NO element yields a value the
-- map collapses to `'{}'::jsonb`, flagging the row for regeneration.
--
-- Applies to BOTH classify_facet.attribute_values (jsonb map) and
-- watcher_versions.classifiers[*].attribute_values (array of defs).
--
-- Guarantees:
--   * IDEMPOTENT — predicates only match array-typed values, and the rebuilt
--     shape is an OBJECT, so a re-run matches 0 rows.
--   * Object-map rows are NEVER touched (predicate is jsonb_typeof = 'array').
--
-- No pg_temp helper is used: the harness applies migrations statement-by-
-- statement over a connection pool, where a session-local pg_temp function
-- would not survive to the next statement. The transform is inlined instead.

-- ---------------------------------------------------------------------------
-- Blast-radius log (visible in migration output; harmless if 0).
-- ---------------------------------------------------------------------------
DO $blast$
DECLARE
  facet_count int;
  version_count int;
BEGIN
  SELECT count(*) INTO facet_count
  FROM classify_facet
  WHERE attribute_values IS NOT NULL
    AND jsonb_typeof(attribute_values) = 'array';

  SELECT count(*) INTO version_count
  FROM watcher_versions
  WHERE classifiers IS NOT NULL
    AND jsonb_typeof(classifiers) = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(classifiers) AS c
      WHERE jsonb_typeof(c->'attribute_values') = 'array'
    );

  RAISE NOTICE '[repair_array_attribute_values] classify_facet array rows: %, watcher_versions rows with array classifier attribute_values: %',
    facet_count, version_count;
END
$blast$;

-- ---------------------------------------------------------------------------
-- 1) classify_facet.attribute_values
-- ---------------------------------------------------------------------------
UPDATE classify_facet cf
SET attribute_values = (
      SELECT COALESCE(
        jsonb_object_agg(elem->>'value', elem - 'value' - 'embedding')
          FILTER (WHERE elem ? 'value' AND coalesce(elem->>'value', '') <> ''),
        '{}'::jsonb
      )
      FROM jsonb_array_elements(cf.attribute_values) AS elem
      WHERE jsonb_typeof(elem) = 'object'
    ),
    updated_at = NOW()
WHERE cf.attribute_values IS NOT NULL
  AND jsonb_typeof(cf.attribute_values) = 'array';

-- ---------------------------------------------------------------------------
-- 2) watcher_versions.classifiers[*].attribute_values
--    Rebuild each classifier def's attribute_values in place, preserving every
--    other field of the def and the array order.
-- ---------------------------------------------------------------------------
UPDATE watcher_versions wv
SET classifiers = (
      SELECT jsonb_agg(
               CASE
                 WHEN jsonb_typeof(def->'attribute_values') = 'array' THEN
                   jsonb_set(
                     def,
                     '{attribute_values}',
                     COALESCE(
                       (
                         SELECT jsonb_object_agg(elem->>'value', elem - 'value' - 'embedding')
                                  FILTER (WHERE elem ? 'value' AND coalesce(elem->>'value', '') <> '')
                         FROM jsonb_array_elements(def->'attribute_values') AS elem
                         WHERE jsonb_typeof(elem) = 'object'
                       ),
                       '{}'::jsonb
                     )
                   )
                 ELSE def
               END
               ORDER BY ord
             )
      FROM jsonb_array_elements(wv.classifiers) WITH ORDINALITY AS t(def, ord)
    )
WHERE wv.classifiers IS NOT NULL
  AND jsonb_typeof(wv.classifiers) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(wv.classifiers) AS c
    WHERE jsonb_typeof(c->'attribute_values') = 'array'
  );

-- migrate:down

-- No-op: the pre-repair array shape was corrupt-on-read (it minted numeric-keyed
-- maps and destroyed value identity). Reconstructing it would reintroduce the
-- data-loss bug, and the original arrays are not retained. Nothing to revert.
SELECT 1;
