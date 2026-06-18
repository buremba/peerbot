-- migrate:up

-- Multi-vector embeddings — EXPAND phase (1 of 2), part 1: add the column.
-- Purely additive (DEFAULT 0 is metadata-only in PG11+), no behavior change.
-- See the chunk-uniq-index migration (next) and the code in this release for the
-- full expand/contract rationale. The CONTRACT release promotes the unique index
-- to the PK, sets embedding_model NOT NULL, decouples the view, and only THEN —
-- gated behind a full rollout so no expand-phase pod is still doing whole-event
-- replace — enables the worker chunker + multi-row writes.
ALTER TABLE public.event_embeddings
    ADD COLUMN IF NOT EXISTS chunk_index integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.event_embeddings.chunk_index IS 'Index of the content chunk this vector embeds (0-based). Until the contract release enables chunking, every row is chunk 0 (one row per event). Then: chunk 0 = lead content, 1..N = tail.';

-- migrate:down

ALTER TABLE public.event_embeddings DROP COLUMN IF EXISTS chunk_index;
