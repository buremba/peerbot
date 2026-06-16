/**
 * Full-text search (FTS) / tsquery helpers:
 * STOPWORDS, buildTsqueryString, NORMALIZED_QUERY_SQL, TSQUERY_SQL,
 * buildSearchDocumentExpr, CANDIDATE_VECTOR_LIMIT, CANDIDATE_QUERY_TIMEOUT_MS.
 */

const STOPWORDS = [
  'what',
  'who',
  'where',
  'when',
  'which',
  'why',
  'how',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'at',
  'on',
  'in',
  'after',
  'before',
  'now',
  'current',
  'latest',
  'approved',
  'made',
];
const STOPWORDS_SET = new Set(STOPWORDS);

/**
 * Build a `tsquery` *string* (OR of clean lexemes, e.g. `"project | codename"`)
 * from a free-text query — the JS mirror of NORMALIZED_QUERY_SQL/TSQUERY_SQL.
 * Returning a plain string lets callers bind it as a parameter to
 * `to_tsquery('english', $N)` so Postgres can use the fulltext GIN index
 * (the in-SQL CASE+regexp form is opaque to the planner). Returns `null` when
 * nothing usable survives normalization.
 */
export function buildTsqueryString(queryText: string): string | null {
  const tokens = queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS_SET.has(t));
  return tokens.length > 0 ? tokens.join(' | ') : null;
}

const NORMALIZED_QUERY_SQL = `trim(regexp_replace(regexp_replace(lower($1), '\\m(${STOPWORDS.join('|')})\\M', ' ', 'g'), '[^a-z0-9\\s]+', ' ', 'g'))`;
export const TSQUERY_SQL = `CASE WHEN NULLIF(${NORMALIZED_QUERY_SQL}, '') IS NOT NULL THEN to_tsquery('english', regexp_replace(${NORMALIZED_QUERY_SQL}, '\\s+', ' | ', 'g')) ELSE NULL END`;

export function buildSearchDocumentExpr(alias: string): string {
  // Reads the GENERATED STORED `search_tsv` column populated by the events
  // table — same shape (title weighted A, payload_text weighted B) the
  // expression used to compute inline, but precomputed at row insert so
  // retrieval (@@) and ranking (ts_rank_cd) hit the same indexed value
  // without rebuilding the vector per matched row.
  return `${alias}.search_tsv`;
}

// Per-source fan-out for the index-driven candidate path — a few hundred from
// each of the ivfflat ANN / fulltext GIN / trigram GIN is plenty for any sane
// content_limit while keeping each index scan cheap.
export const CANDIDATE_VECTOR_LIMIT = 200;
// Backstop so a pathological candidate scan can't hang the request. Every caller
// tolerates an empty content list, so failing fast and degrading to "no content"
// beats a multi-minute query.
export const CANDIDATE_QUERY_TIMEOUT_MS = 6000;
