-- Recall benchmark for `idx_events_embedding` (ivfflat, vector_cosine_ops).
--
-- WHY: the ANN index is built over the whole `event_embeddings` table with no
-- partial predicate, while production retrieval excludes rows with a non-NULL
-- `superseded_by`. Superseded vectors can therefore consume scan budget. The
-- benchmark pins the default `ivfflat.probes = 1` and disables iterative scan
-- to expose that loss.
--
-- WHAT IT MEASURES, per sampled query vector:
--   recall@k        |ANN top-k ∩ exact top-k| / |exact top-k|, live rows only.
--                   ANN mirrors the index/live-filter order of the candidate
--                   branch in packages/server/src/utils/content-search/search-path.ts
--                   (inner `LIMIT CANDIDATE_VECTOR_LIMIT * 3` over chunk rows
--                   joined to live events, collapsed to distinct events by
--                   their nearest chunk).
--   probed          rows the ivfflat scan produced before the inner LIMIT.
--   live_probed     how many of those survived the live-row join.
--   exact_n/ann_n   how many rows each leg actually returned (k unless the
--                   corpus is smaller).
--
-- The exact leg defeats the index with `+ 0.0` on the distance expression, so
-- it is a brute-force sort over live rows (verify with EXPLAIN if in doubt).
--
-- READ-ONLY: no DDL, no temp tables, no writes. Safe against a replica or prod.
-- Cost: one full scan of the live vectors per sampled query (~7-10s each on the
-- 2026-08 prod shape, measured). Keep :n_queries modest against a live primary.
--
-- USAGE
--   psql "$DATABASE_URL" -f scripts/bench-vector-recall.sql
--   psql "$DATABASE_URL" -v n_queries=20 -v k=20 -v probes=1 \
--        -f scripts/bench-vector-recall.sql
--
-- Against prod (read-only recipe; run from a shell with kubectl access):
--   kubectl exec -i -n summaries-prod lobu-db-prod-1 -c postgres -- \
--     env PGPASSWORD="$PW" psql -U summaries -h 127.0.0.1 -d owletto \
--     -v n_queries=20 < scripts/bench-vector-recall.sql
--
-- PAIRED BEFORE/AFTER. The default query set is drawn by a seeded TABLESAMPLE,
-- which is stable only while the table content is — and the reclaim changes the
-- content. For a true paired comparison, copy the `query_event_id` column from
-- the BEFORE run and pin it on the AFTER run:
--   psql ... -v query_ids='1159435,1752302,1808609' -v n_queries=3 \
--        -f scripts/bench-vector-recall.sql
-- Reclaim leaves these query vectors alone as long as the sampled events remain
-- live between runs.

\set ON_ERROR_STOP on

\if :{?model}
\else
\set model 'Xenova/bge-base-en-v1.5'
\endif
\if :{?n_queries}
\else
\set n_queries 20
\endif
\if :{?k}
\else
\set k 20
\endif
-- CANDIDATE_VECTOR_LIMIT (= 200, packages/server/src/utils/content-search/fts.ts)
-- times the 3x chunk over-fetch applied in search-path.ts.
\if :{?ann_limit}
\else
\set ann_limit 600
\endif
\if :{?probes}
\else
\set probes 1
\endif
-- TABLESAMPLE percentage used to draw the query set cheaply from the heap.
-- SYSTEM sampling picks whole BLOCKS, so on a small table 2% can draw nothing
-- and the recall table comes back as a single all-NULL MEAN row. That is an
-- empty sample, not a zero score — raise :sample_pct or pin :query_ids.
\if :{?sample_pct}
\else
\set sample_pct 2
\endif
\if :{?seed}
\else
\set seed 0.42
\endif
-- TABLESAMPLE has its own PRNG; REPEATABLE pins it so the query set is stable.
\if :{?tablesample_seed}
\else
\set tablesample_seed 42
\endif
-- Optional comma-separated event ids to use as the query set instead of the
-- seeded sample — the paired before/after knob described above.
\if :{?query_ids}
\else
\set query_ids ''
\endif

-- The exact leg is a brute-force scan per query, so the whole statement runs for
-- minutes. Raise the timeout the app role ships with rather than inheriting it.
\if :{?statement_timeout}
\else
\set statement_timeout '900s'
\endif

-- Force the `vector` library to load so its GUCs are registered before SET.
SELECT '[1]'::vector IS NOT NULL AS vector_loaded \gset
SET ivfflat.probes = :probes;
SET ivfflat.iterative_scan = off;
SET statement_timeout = :'statement_timeout';

\echo '── configuration ─────────────────────────────────────────────'
SELECT :'model'      AS embedding_model,
       :n_queries    AS n_queries,
       :k            AS k,
       :ann_limit    AS ann_inner_limit,
       current_setting('ivfflat.probes')         AS probes,
       current_setting('ivfflat.iterative_scan') AS iterative_scan,
       (SELECT reloptions FROM pg_class WHERE relname = 'idx_events_embedding') AS index_opts;

\echo '── corpus ────────────────────────────────────────────────────'
SELECT count(*)                                            AS vectors_total,
       count(*) FILTER (WHERE e.superseded_by IS NULL)     AS vectors_live,
       count(*) FILTER (WHERE e.superseded_by IS NOT NULL) AS vectors_dead,
       round(100.0 * count(*) FILTER (WHERE e.superseded_by IS NOT NULL)
             / nullif(count(*), 0), 2)                     AS pct_dead
FROM event_embeddings emb
JOIN events e ON e.id = emb.event_id
WHERE emb.embedding_model = :'model';

\echo '── recall ────────────────────────────────────────────────────'
SELECT setseed(:seed) \gset

WITH sample_pool AS (
  -- Use chunk 0 so qid uniquely identifies one query vector per event.
  -- Default: a cheap seeded TABLESAMPLE over the heap, live rows only.
  SELECT emb.event_id AS qid, emb.embedding AS vec
  FROM event_embeddings emb TABLESAMPLE SYSTEM (:sample_pct) REPEATABLE (:tablesample_seed)
  JOIN events e ON e.id = emb.event_id
  WHERE emb.embedding_model = :'model'
    AND emb.chunk_index = 0
    AND e.superseded_by IS NULL
    AND :'query_ids' = ''
  UNION ALL
  -- Pinned: the explicit query set, for a paired before/after run.
  SELECT emb.event_id, emb.embedding
  FROM event_embeddings emb
  JOIN events e ON e.id = emb.event_id
  WHERE emb.embedding_model = :'model'
    AND emb.chunk_index = 0
    AND e.superseded_by IS NULL
    AND :'query_ids' <> ''
    AND emb.event_id = ANY(string_to_array(:'query_ids', ',')::bigint[])
),
sample AS MATERIALIZED (
  SELECT qid, vec FROM sample_pool
  ORDER BY random()
  LIMIT :n_queries
),
-- Brute-force ground truth over live rows, collapsed to distinct events by
-- their nearest chunk. `+ 0.0` makes the sort key non-indexable.
exact AS MATERIALIZED (
  SELECT s.qid, x.event_id
  FROM sample s
  CROSS JOIN LATERAL (
    SELECT emb.event_id, min((emb.embedding <=> s.vec) + 0.0) AS dist
    FROM event_embeddings emb
    JOIN events e ON e.id = emb.event_id
    WHERE emb.embedding_model = :'model'
      AND e.superseded_by IS NULL
    GROUP BY emb.event_id
    ORDER BY dist
    LIMIT :k
  ) x
),
-- Production candidate branch's index/live-filter order.
ann AS MATERIALIZED (
  SELECT s.qid, a.event_id
  FROM sample s
  CROSS JOIN LATERAL (
    SELECT id AS event_id
    FROM (
      SELECT emb.event_id AS id, (emb.embedding <=> s.vec) AS dist
      FROM event_embeddings emb
      JOIN events f ON f.id = emb.event_id
      WHERE emb.embedding_model = :'model'
        AND f.superseded_by IS NULL
      ORDER BY emb.embedding <=> s.vec
      LIMIT :ann_limit
    ) c
    GROUP BY id
    ORDER BY min(dist)
    LIMIT :k
  ) a
),
-- What the probe budget actually bought: how many of the raw ANN candidates
-- were live at all.
probe AS MATERIALIZED (
  SELECT s.qid,
         count(*)                                  AS probed,
         count(*) FILTER (WHERE f.id IS NOT NULL)  AS live_probed
  FROM sample s
  CROSS JOIN LATERAL (
    SELECT emb.event_id
    FROM event_embeddings emb
    WHERE emb.embedding_model = :'model'
    ORDER BY emb.embedding <=> s.vec
    LIMIT :ann_limit
  ) p
  LEFT JOIN events f ON f.id = p.event_id AND f.superseded_by IS NULL
  GROUP BY s.qid
),
per_query AS (
  SELECT s.qid,
         (SELECT count(*) FROM exact x WHERE x.qid = s.qid)::int AS exact_n,
         (SELECT count(*) FROM ann a   WHERE a.qid = s.qid)::int AS ann_n,
         (SELECT count(*) FROM ann a
           WHERE a.qid = s.qid
             AND EXISTS (SELECT 1 FROM exact x
                          WHERE x.qid = s.qid AND x.event_id = a.event_id))::int AS hits,
         pr.probed::int      AS probed,
         pr.live_probed::int AS live_probed
  FROM sample s
  JOIN probe pr ON pr.qid = s.qid
)
SELECT query_event_id, exact_n, ann_n, hits, recall_pct, probed, live_probed, probe_live_pct
FROM (
  SELECT 0                                                             AS ord,
         qid::text                                                     AS query_event_id,
         exact_n::numeric                                              AS exact_n,
         ann_n::numeric                                                AS ann_n,
         hits::numeric                                                 AS hits,
         round(100.0 * hits / nullif(exact_n, 0), 1)                   AS recall_pct,
         probed::numeric                                               AS probed,
         live_probed::numeric                                          AS live_probed,
         round(100.0 * live_probed / nullif(probed, 0), 1)             AS probe_live_pct
  FROM per_query
  UNION ALL
  SELECT 1,
         'MEAN',
         round(avg(exact_n), 1),
         round(avg(ann_n), 1),
         round(avg(hits), 1),
         round(avg(100.0 * hits / nullif(exact_n, 0)), 1),
         round(avg(probed), 1),
         round(avg(live_probed), 1),
         round(avg(100.0 * live_probed / nullif(probed, 0)), 1)
  FROM per_query
) r
ORDER BY ord, query_event_id;
