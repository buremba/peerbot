-- migrate:up

-- Stamp every existing classifier label vector with the model that produced it.
--
-- `classify_facet.attribute_values[value].embedding` is cosine-compared against
-- `event_embeddings.embedding`. The event side has been model-scoped since
-- 20260526120000 (stamp) / 20260618140000 (NOT NULL, part of the PK), because
-- vectors from different models are not comparable even at equal dimensionality.
-- The label side never got a stamp, so it is the half a model swap leaves
-- behind — and cosine over two incompatible 768-dim spaces returns a plausible
-- number rather than an error, so classification keeps running and silently
-- assigns wrong labels.
--
-- The engine now drops any label vector whose stamp is not the configured model.
-- Without this backfill that guard would treat all 208 existing vectors
-- (28 classifiers, measured on prod 2026-07-31) as unknown-provenance and stop
-- classifying at deploy — so this migration is what makes the guard a no-op for
-- data that is in fact fine.
--
-- The stamp is DERIVED, not hardcoded: label vectors were produced by whatever
-- model the install has been running, so read that off event_embeddings rather
-- than assuming the default. Prod holds exactly one distinct value
-- (Xenova/bge-base-en-v1.5, 2,060,864 rows), and an install with no events at
-- all falls back to the code default. The aggregate is a one-time full scan of a
-- ~2M-row table in the deploy hook (seconds); it is the "run the aggregation in
-- a migration, never per request" case, and nothing reads it again afterwards.
--
-- Idempotent: only entries with a vector AND no stamp are touched, so a re-run
-- is a no-op. Deliberately does NOT invent a stamp for entries with no vector —
-- a stamp must never outlive the vector it describes.

WITH prevailing AS (
    SELECT COALESCE(
        (SELECT embedding_model
           FROM public.event_embeddings
          GROUP BY embedding_model
          ORDER BY count(*) DESC
          LIMIT 1),
        'Xenova/bge-base-en-v1.5'
    ) AS model
)
UPDATE public.classify_facet cf
SET attribute_values = (
        SELECT jsonb_object_agg(
            e.key,
            CASE
                WHEN jsonb_typeof(e.value) = 'object'
                 AND jsonb_typeof(e.value -> 'embedding') = 'array'
                 AND NOT (e.value ? 'embedding_model')
                THEN e.value || jsonb_build_object('embedding_model', (SELECT model FROM prevailing))
                ELSE e.value
            END
        )
          FROM jsonb_each(cf.attribute_values) e
    ),
    updated_at = now()
WHERE jsonb_typeof(cf.attribute_values) = 'object'
  -- Guards the jsonb_object_agg above: over zero rows it returns NULL, which
  -- would blank the column. An entry-less `{}` cannot reach the SET.
  AND EXISTS (
        SELECT 1
          FROM jsonb_each(cf.attribute_values) e
         WHERE jsonb_typeof(e.value) = 'object'
           AND jsonb_typeof(e.value -> 'embedding') = 'array'
           AND NOT (e.value ? 'embedding_model')
    );

-- migrate:down

-- Strip the stamp back out. Vectors are left in place — they were never
-- rewritten, only annotated.
UPDATE public.classify_facet cf
SET attribute_values = (
        SELECT jsonb_object_agg(
            e.key,
            CASE WHEN jsonb_typeof(e.value) = 'object'
                 THEN e.value - 'embedding_model'
                 ELSE e.value END
        )
          FROM jsonb_each(cf.attribute_values) e
    )
WHERE jsonb_typeof(cf.attribute_values) = 'object'
  AND EXISTS (
        SELECT 1 FROM jsonb_each(cf.attribute_values) e
         WHERE jsonb_typeof(e.value) = 'object' AND e.value ? 'embedding_model'
    );
