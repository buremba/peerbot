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
-- Operational note: ADD COLUMN ... GENERATED STORED rewrites the table and
-- takes ACCESS EXCLUSIVE for the duration. On a 1M-row events table expect
-- on the order of a minute; run during a quiet window. CONCURRENTLY does not
-- apply to ADD COLUMN; it only applies to CREATE INDEX, which we do below
-- separately so it doesn't block writes.

ALTER TABLE public.events
    ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(payload_text, '')), 'B')
    ) STORED;

CREATE INDEX idx_events_search_tsv ON public.events USING gin (search_tsv);

DROP INDEX IF EXISTS public.idx_events_fulltext;

-- migrate:down

CREATE INDEX idx_events_fulltext ON public.events
    USING gin (to_tsvector('english'::regconfig, COALESCE(payload_text, ''::text)));
DROP INDEX IF EXISTS public.idx_events_search_tsv;
ALTER TABLE public.events DROP COLUMN search_tsv;
