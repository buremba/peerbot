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

-- Expose the stamp through current_event_records so similarity queries on the
-- view can scope to a single model. Appended at the end so CREATE OR REPLACE
-- keeps the existing column order; otherwise byte-identical to the baseline.
CREATE OR REPLACE VIEW public.current_event_records AS
 SELECT e.id,
    e.organization_id,
    e.entity_ids,
    e.origin_id,
    e.title,
    e.payload_type,
    e.payload_text,
    e.payload_data,
    e.payload_template,
    e.attachments,
    e.metadata,
    e.score,
    emb.embedding,
    e.author_name,
    e.source_url,
    e.occurred_at,
    e.created_at,
    e.origin_parent_id,
    COALESCE(length(e.payload_text), 0) AS content_length,
    e.search_tsv,
    e.origin_type,
    e.connector_key,
    e.connection_id,
    e.feed_key,
    e.feed_id,
    e.run_id,
    e.semantic_type,
    e.client_id,
    e.created_by,
    e.interaction_type,
    e.interaction_status,
    e.interaction_input_schema,
    e.interaction_input,
    e.interaction_output,
    e.interaction_error,
    e.supersedes_event_id,
    emb.embedding_model
   FROM (public.events e
     LEFT JOIN public.event_embeddings emb ON ((emb.event_id = e.id)))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.events newer
          WHERE (newer.supersedes_event_id = e.id))));

-- migrate:down

-- CREATE OR REPLACE VIEW cannot REMOVE a column from an existing view (Postgres
-- only allows appending columns at the end). Drop and recreate
-- current_event_records WITHOUT embedding_model; the recreated view no longer
-- references the column, so the subsequent DROP COLUMN succeeds.
DROP VIEW IF EXISTS public.current_event_records;
CREATE VIEW public.current_event_records AS
 SELECT e.id,
    e.organization_id,
    e.entity_ids,
    e.origin_id,
    e.title,
    e.payload_type,
    e.payload_text,
    e.payload_data,
    e.payload_template,
    e.attachments,
    e.metadata,
    e.score,
    emb.embedding,
    e.author_name,
    e.source_url,
    e.occurred_at,
    e.created_at,
    e.origin_parent_id,
    COALESCE(length(e.payload_text), 0) AS content_length,
    e.search_tsv,
    e.origin_type,
    e.connector_key,
    e.connection_id,
    e.feed_key,
    e.feed_id,
    e.run_id,
    e.semantic_type,
    e.client_id,
    e.created_by,
    e.interaction_type,
    e.interaction_status,
    e.interaction_input_schema,
    e.interaction_input,
    e.interaction_output,
    e.interaction_error,
    e.supersedes_event_id
   FROM (public.events e
     LEFT JOIN public.event_embeddings emb ON ((emb.event_id = e.id)))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.events newer
          WHERE (newer.supersedes_event_id = e.id))));

ALTER TABLE public.event_embeddings DROP COLUMN IF EXISTS embedding_model;
