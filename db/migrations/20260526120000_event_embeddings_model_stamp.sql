-- migrate:up

-- Version-stamp every embedding with the model that produced it. Without this,
-- swapping EMBEDDINGS_MODEL to a different model of the SAME dimensionality
-- silently mixes incompatible vector spaces in event_embeddings with no way to
-- detect or segregate the mismatched rows. The stamp lets future similarity
-- queries scope to a single model and makes a model swap auditable.
--
-- NULL = produced before this column existed (legacy rows, unknown model).
ALTER TABLE public.event_embeddings ADD COLUMN IF NOT EXISTS embedding_model text;

COMMENT ON COLUMN public.event_embeddings.embedding_model IS 'Model/version stamp of the embedding model that produced this vector (e.g. "Xenova/bge-base-en-v1.5"). NULL = legacy row written before stamping. Vectors from different stamps are NOT comparable even at equal dimensionality.';

-- migrate:down

ALTER TABLE public.event_embeddings DROP COLUMN IF EXISTS embedding_model;
