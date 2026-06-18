-- migrate:up

-- Multi-vector embeddings — CONTRACT phase (2 of 3).
-- Safe only once every pod runs the expand-phase code (#1370): reads already
-- join event_embeddings directly; writes use delete-then-insert (no ON CONFLICT
-- on event_id). This release promotes the expand-phase unique index to the PK,
-- enforces embedding_model NOT NULL, and decouples current_event_records back to
-- pure supersession masking. Still no chunking enabled — one chunk-0 row per
-- (event, model) in practice.

-- Legacy NULL-stamp rows are unusable (search scopes by model) and block NOT
-- NULL. The backfill migration stamped known legacy rows; anything still NULL
-- is orphan data from a restore or a pre-stamp edge case — drop it.
DELETE FROM public.event_embeddings WHERE embedding_model IS NULL;

-- NULL rows are gone (above); the scan+lock is acceptable in the deploy hook.
-- squawk-ignore prefer-robust-stmts,adding-not-nullable-field
ALTER TABLE public.event_embeddings ALTER COLUMN embedding_model SET NOT NULL;

-- Brief catalog lock during the PK swap is acceptable in the deploy hook (the
-- expand-phase CONCURRENTLY-built unique index is already in place).
ALTER TABLE public.event_embeddings DROP CONSTRAINT IF EXISTS event_embeddings_pkey;
ALTER TABLE public.event_embeddings
    ADD CONSTRAINT event_embeddings_pkey
    PRIMARY KEY USING INDEX event_embeddings_event_model_chunk_uniq;

COMMENT ON COLUMN public.event_embeddings.embedding_model IS
    'Model/version stamp of the embedding model that produced this vector (e.g. "Xenova/bge-base-en-v1.5"). NOT NULL — part of the PK. Vectors from different stamps are NOT comparable even at equal dimensionality.';

-- CREATE OR REPLACE VIEW cannot remove columns; drop and recreate without the
-- embedding join. Vector callers already read event_embeddings directly.
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
   FROM public.events e
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.events newer
          WHERE (newer.supersedes_event_id = e.id))));

-- migrate:down

-- Intentionally a no-op: reversing the PK swap or re-coupling the view is
-- unsafe once multi-vector / multi-model rows exist. PITR is the rollback path.
SELECT 1;