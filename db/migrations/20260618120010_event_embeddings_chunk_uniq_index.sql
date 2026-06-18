-- migrate:up transaction:false

-- The future multi-vector PK (event_id, embedding_model, chunk_index), built
-- additively and CONCURRENTLY so the build never blocks writes on the hot
-- event_embeddings table during the pre-deploy migration hook (one statement per
-- transaction:false migration — dbmate sends the block as one simple-query batch
-- and CONCURRENTLY can't run inside the implicit transaction a multi-statement
-- batch gets). The CONTRACT release promotes this index to the primary key.
-- It coexists with the current PK(event_id): expand-phase data is one row per
-- event (chunk 0, single model), so both constraints hold. NULLs are distinct in
-- a unique index, so legacy NULL-stamp rows don't collide.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS event_embeddings_event_model_chunk_uniq
    ON public.event_embeddings (event_id, embedding_model, chunk_index);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.event_embeddings_event_model_chunk_uniq;
