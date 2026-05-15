-- migrate:up

-- Materialize the fulltext search vector as a STORED column.
--
-- Why a real column instead of the previous expression-indexed `to_tsvector(payload_text)`:
--   1. It includes both `title` (weight A) and `payload_text` (weight B) — the
--      same shape buildSearchDocumentExpr() in content-search.ts uses for
--      ranking. Retrieval (@@) and ts_rank_cd now read the same vector, so
--      title-only hits surface correctly and ranking doesn't recompute the
--      vector per matched row at query time.
--   2. Planner-stable: `search_tsv @@ to_tsquery(...)` is a plain column
--      reference — no expression-shape matching, no aliasing risk where the
--      GIN gets skipped because the WHERE expression isn't byte-identical to
--      the indexed expression.
--   3. The new GIN strictly subsumes the old payload-only one (same lexemes
--      plus title's), so we drop the old index and recover its write
--      amplification on every events insert.
--
-- Operational note: ADD COLUMN ... GENERATED STORED rewrites the events
-- table under ACCESS EXCLUSIVE. On a 1M-row table expect on the order of a
-- minute; run during a quiet window. CONCURRENTLY does not apply to ADD
-- COLUMN; it only applies to CREATE INDEX, which is a separate statement
-- below.

ALTER TABLE public.events
    ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(payload_text, '')), 'B')
    ) STORED;

CREATE INDEX idx_events_search_tsv ON public.events USING gin (search_tsv);

DROP INDEX IF EXISTS public.idx_events_fulltext;

-- Recreate the current_event_records view so it exposes search_tsv to
-- callers that go through the supersession filter (the view materializes
-- its column list at create time, so `e.*`-style auto-pickup doesn't
-- apply). buildSearchDocumentExpr() reads `f.search_tsv` / `fi.search_tsv`
-- where f and fi are this view's aliases, so without this the view-backed
-- queries fail with "column ... does not exist".

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

-- migrate:down

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

CREATE INDEX idx_events_fulltext ON public.events
    USING gin (to_tsvector('english'::regconfig, COALESCE(payload_text, ''::text)));
DROP INDEX IF EXISTS public.idx_events_search_tsv;
ALTER TABLE public.events DROP COLUMN search_tsv;
