-- migrate:up

-- 20260526120000 added event_embeddings.embedding_model but left existing rows
-- NULL. The model-scoped vector search (content-search.ts) excludes NULL stamps,
-- so every legacy embedding silently dropped out of vector search until
-- re-embedded — a full-corpus semantic-recall regression on deploy. Legacy rows
-- were all produced by the default model (the only model used before stamping
-- existed), so stamp them with it directly: the label is accurate, no
-- re-embedding needed. The literal MUST match DEFAULT_EMBEDDING_MODEL in
-- packages/server/src/utils/embeddings.ts. (Assumes the default model for legacy
-- rows; an env that ran a non-default EMBEDDINGS_MODEL before this column existed
-- should stamp accordingly.) Idempotent + a no-op once stamped (only touches NULL
-- rows, e.g. on a PITR restore from before the manual prod backfill).
UPDATE public.event_embeddings
SET embedding_model = 'Xenova/bge-base-en-v1.5'
WHERE embedding_model IS NULL;

-- migrate:down

-- Intentionally a no-op: re-NULLing would reintroduce the recall regression, and
-- the stamp records the embedding's true model, so there is nothing to revert.
SELECT 1;
