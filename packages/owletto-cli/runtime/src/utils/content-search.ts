/**
 * Content Search Utilities
 *
 * Hybrid search: combines PostgreSQL ILIKE text matching with pgvector
 * cosine-distance semantic search when the embeddings service is available.
 * Falls back to ILIKE-only when embeddings cannot be generated.
 */

import { type DbClient, getDb } from '../db/client';
import type { Env } from '../index';
import {
  buildConnectionFilter,
  buildOrderByClause,
  type ClassificationFilter,
  groupClassificationFilters,
} from './content-query-filters';
import { parseDateAlias, toEndOfDay } from './date-aliases';
import { generateEmbeddings } from './embeddings';
import { toVectorLiteral } from './entity-management';
import logger from './logger';
import { expandSearchQueries } from './query-expansion';

const CONTEXT_CASE_SQL = `
        CASE
          WHEN f.origin_parent_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM result_set rs2 JOIN current_event_records f2 ON rs2.id = f2.id WHERE f2.origin_id = f.origin_parent_id)
          THEN jsonb_build_object(
            'author_name', p.author_name,
            'title', p.title,
            'text_content', LEFT(p.payload_text, 200),
            'occurred_at', p.occurred_at,
            'source_url', p.source_url,
            'score', p.score
          )
          ELSE NULL
        END as parent_context,
        CASE
          WHEN tm.depth > 0
            AND NOT EXISTS (SELECT 1 FROM result_set rs2 JOIN current_event_records f2 ON rs2.id = f2.id WHERE f2.origin_id = tm.root_origin_id)
          THEN jsonb_build_object(
            'author_name', root.author_name,
            'title', root.title,
            'occurred_at', root.occurred_at,
            'source_url', root.source_url,
            'score', root.score
          )
          ELSE NULL
        END as root_context`;

const FINAL_JOINS_SQL = `
      LEFT JOIN connections c ON c.id = f.connection_id
      LEFT JOIN thread_meta tm ON tm.content_id = f.id`;

const FINAL_JOINS_WITH_CLASSIFICATIONS_SQL = `${FINAL_JOINS_SQL}
      LEFT JOIN latest_classifications lc_all ON lc_all.event_id = f.id
      LEFT JOIN event_classifiers fcl_all ON lc_all.classifier_id = fcl_all.id`;

const PARENT_ROOT_JOINS_SQL = `
      LEFT JOIN current_event_records p ON f.origin_parent_id = p.origin_id AND p.entity_ids && f.entity_ids
      LEFT JOIN current_event_records root ON tm.root_origin_id = root.origin_id AND root.entity_ids && f.entity_ids`;

const BASE_COLUMNS_SQL = `f.id, f.entity_ids, f.connection_id, f.payload_text, f.title, f.author_name, f.source_url, f.occurred_at, f.semantic_type,
          f.connector_key as platform, f.origin_id, f.origin_parent_id, f.score, f.metadata, f.payload_type, f.payload_data, f.payload_template, f.attachments, f.origin_type,
          f.interaction_type, f.interaction_status, f.interaction_input_schema, f.interaction_input, f.interaction_output, f.interaction_error, f.supersedes_event_id`;

const CLASSIFICATION_COLUMNS_SQL = `fcl_all.attribute_key as classifier_attribute_key,
          lc_all."values" as classifier_values,
          lc_all.confidences as classifier_confidences,
          lc_all.source as classifier_source,
          lc_all.is_manual as classifier_is_manual`;

function buildFinalSelect(opts: {
  withClassifications: boolean;
  extraColumns?: string;
  orderBy: string;
}): string {
  const classificationCol = opts.withClassifications
    ? CLASSIFICATION_COLUMNS_SQL
    : 'NULL as classifications';
  const extra = opts.extraColumns ? `,\n          ${opts.extraColumns}` : '';
  const joins = opts.withClassifications ? FINAL_JOINS_WITH_CLASSIFICATIONS_SQL : FINAL_JOINS_SQL;
  return `
      SELECT
        ${BASE_COLUMNS_SQL},
        ${classificationCol}${extra},
        f.created_at,
        COALESCE(tm.root_origin_id, f.origin_id, CAST(f.id AS VARCHAR)) as root_origin_id,
        tm.depth,
${CONTEXT_CASE_SQL}
      FROM result_set rs
      JOIN current_event_records f ON f.id = rs.id${joins}
${PARENT_ROOT_JOINS_SQL}
      ORDER BY ${opts.orderBy}`;
}

function deduplicateWithClassifications(rawRows: any[]): ContentSearchResult[] {
  const classificationsMap = aggregateClassifications(rawRows);
  const seenIds = new Set<number>();
  const results: ContentSearchResult[] = [];
  for (const row of rawRows) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    results.push({
      ...row,
      classifications: classificationsMap.get(row.id) ?? {},
      classifier_attribute_key: undefined,
      classifier_values: undefined,
      classifier_confidences: undefined,
      classifier_source: undefined,
      classifier_is_manual: undefined,
    } as any as ContentSearchResult);
  }
  return results;
}

function buildStandardParams(
  options: ContentSearchOptions & { offset?: number },
  extra?: {
    sinceDate: Date | null;
    untilDate: Date | null;
  }
): any[] {
  const sinceDate = extra?.sinceDate ?? (options.since ? parseDateAlias(options.since).date : null);
  const untilDate =
    extra?.untilDate ?? (options.until ? toEndOfDay(parseDateAlias(options.until).date) : null);
  return [
    options.entity_id ?? null,
    options.platform ?? null,
    sinceDate?.toISOString() ?? null,
    untilDate?.toISOString() ?? null,
    options.window_id ?? null,
    options.engagement_min ?? null,
    options.engagement_max ?? null,
    options.classification_source ?? null,
    options.semantic_type ?? null,
    options.interaction_status ?? null,
  ];
}

/**
 * Standard identity namespaces (mirror of IDENTITY in @lobu/owletto-sdk).
 * Kept local so content-search.ts doesn't take a build-time dep on the SDK.
 *
 * Adding a namespace here is a three-step change:
 *   1. Add the key to `IDENTITY` in @lobu/owletto-sdk so connectors can reference it.
 *   2. Add a partial BTREE index `idx_events_metadata_<ns>` in a migration
 *      (see db/migrations/20260419120000_add_event_identity_indexes.sql).
 *   3. Add the string to this list — `entityLinkMatchSql` will emit a UNION
 *      branch that uses the new index.
 *
 * Non-standard namespaces are intentionally unsupported at read time: without
 * a matching index the identity branch seq-scans `events`, which blows up the
 * entire content query. If a connector needs a new namespace, add the index.
 */
const STANDARD_IDENTITY_NAMESPACES = [
  'email',
  'phone',
  'wa_jid',
  'slack_user_id',
  'github_login',
  'auth_user_id',
  'google_contact_id',
] as const;

/**
 * SQL predicate: "event `<alias>` is linked to entity `<paramRef>`".
 *
 * Matches two ways:
 *   1. Legacy / feed-pinned attribution: entity id appears in `events.entity_ids`.
 *   2. Identity-graph attribution: a live `entity_identities` row claims an
 *      identifier that the event carries in `metadata->>namespace` (stamped
 *      there by `applyEntityLinks` at ingestion; see src/utils/entity-link-upsert.ts).
 *
 * Events are append-only, so (2) is how connector-driven auto-linking is
 * surfaced at read time — `entity_ids` is never mutated post-insert.
 *
 * Shape: `alias.id IN (UNION …)`. Each standard namespace gets its own UNION
 * branch with a literal `ei.namespace = '<ns>'` so Postgres can evaluate the
 * join against `entity_identities` first, then probe `events` via the
 * per-namespace partial BTREE index `idx_events_metadata_<ns>`. Writing this
 * as a top-level OR of EXISTS branches — or as a single identity branch with
 * `OR` across namespaces — forces Parallel Seq Scan on `events` because the
 * namespace becomes a join filter instead of a restrictable predicate.
 */
export function entityLinkMatchSql(paramRef: string, alias = 'f'): string {
  const directBranch = `SELECT e2.id FROM events e2 WHERE e2.entity_ids @> ARRAY[${paramRef}]`;

  const standardBranches = STANDARD_IDENTITY_NAMESPACES.map(
    (ns) => `SELECT e2.id FROM events e2
      JOIN entity_identities ei
        ON ei.entity_id = ${paramRef}
       AND ei.namespace = '${ns}'
       AND ei.deleted_at IS NULL
      WHERE e2.metadata ? '${ns}' AND e2.metadata->>'${ns}' = ei.identifier`
  );

  const branches = [directBranch, ...standardBranches].join('\n    UNION\n    ');
  return `${alias}.id IN (\n    ${branches}\n  )`;
}

const STANDARD_WHERE_SQL = `($1::bigint IS NULL OR ${entityLinkMatchSql('$1::bigint')})
          AND ($2::text IS NULL OR f.connector_key = $2::text)
          AND ($3::timestamptz IS NULL OR f.occurred_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR f.occurred_at <= $4::timestamptz)
          AND ($5::int IS NULL OR iwf.window_id = $5::int)
          AND ($6::numeric IS NULL OR f.score >= $6::numeric)
          AND ($7::numeric IS NULL OR f.score <= $7::numeric)
          AND ($8::text IS NULL OR EXISTS (
            SELECT 1 FROM latest_event_classifications lc_source
            WHERE lc_source.event_id = f.id
              AND lc_source.source = $8::text
          ))
          AND ($9::text IS NULL OR f.semantic_type = $9::text)
          AND ($10::text IS NULL OR f.interaction_status = $10::text)`;

const WINDOW_JOIN_SQL = `LEFT JOIN watcher_window_events iwf
          ON iwf.event_id = f.id
          AND ($5::int IS NOT NULL)
          AND iwf.window_id = $5::int`;

/**
 * Build NOT EXISTS clause to exclude content already in any window for a given watcher
 * @param excludeWatcherId - Watcher ID to exclude content for
 * @param tableAlias - Alias for the content table (default: 'f')
 * @returns SQL clause string or empty string if not filtering
 */
function buildExcludeWatcherClause(excludeWatcherId: number | undefined, tableAlias = 'f'): string {
  if (excludeWatcherId === undefined) return '';
  return ` AND NOT EXISTS (
    SELECT 1 FROM watcher_window_events exc_iwe
    JOIN watcher_windows exc_iw ON exc_iw.id = exc_iwe.window_id
    WHERE exc_iwe.event_id = ${tableAlias}.id AND exc_iw.watcher_id = ${excludeWatcherId}
  )`;
}

/**
 * Build an org/workspace-scoping WHERE clause using EXISTS (no JOIN needed).
 * Returns an empty string when no scoping is needed (e.g. entity_id is set).
 * Assumes the query has `f` aliasing events and `c` aliasing connections.
 */
function buildOrgScopeWhere(options: {
  entity_id?: number;
  organization_id?: string;
  baseParamIndex: number;
}): { sql: string; params: unknown[] } {
  if (options.entity_id || !options.organization_id) return { sql: '', params: [] };

  const p = `$${options.baseParamIndex}::text`;
  const existsCond = `EXISTS (SELECT 1 FROM entities ent_org WHERE ent_org.id = ANY(f.entity_ids) AND ent_org.organization_id = ${p})`;
  const connCond = `(c.organization_id = ${p} OR f.organization_id = ${p})`;
  return {
    sql: `AND (${existsCond} OR ((f.entity_ids IS NULL OR f.entity_ids = '{}') AND ${connCond}))`,
    params: [options.organization_id],
  };
}

/**
 * Search options for content vector search
 */
export interface ContentSearchOptions {
  // Entity filtering
  entity_id?: number;
  organization_id?: string; // Required when entity_id is omitted (org-wide mode)

  connection_ids?: number[]; // Array of connection IDs to filter by
  window_id?: number; // Filter by watcher window ID
  exclude_watcher_id?: number; // Exclude content already in any window for this watcher
  platform?: string;
  since?: string; // ISO date or relative ("7d", "30d")
  until?: string; // ISO date
  engagement_min?: number; // Minimum engagement score (0-100)
  engagement_max?: number; // Maximum engagement score (0-100)
  min_similarity?: number; // 0.0 - 1.0, default: 0.6
  limit?: number; // default: 50, max: 100
  content_ids?: number[]; // Filter to specific content IDs
  semantic_type?: string; // Filter by semantic type (e.g. note, summary, decision)
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';

  // Classification options (only JOINs when needed)
  include_classifications?: boolean; // Include classifications in results
  classification_filters?: ClassificationFilter[]; // Filter by classifications
  classification_source?: 'user' | 'embedding' | 'llm'; // Filter by classification source

  // Sorting options
  sort_by?: 'date' | 'score'; // Sort by date or engagement score (default: date)
  sort_order?: 'asc' | 'desc'; // Sort order (default: desc)
  before_occurred_at?: string; // Chronological cursor anchor for older results
  before_id?: number; // Stable tie-breaker for before_occurred_at
  after_occurred_at?: string; // Chronological cursor anchor for newer results
  after_id?: number; // Stable tie-breaker for after_occurred_at

  // Ranking tuning. combined_score = vector_weight*cosine + (1-vector_weight)*text_rank
  // when both signals are available. Defaults to 0.6 (60% vector, 40% text) which
  // matches the prior hard-coded behavior. Raise toward 1.0 for noisy/long-form content
  // where text rank is dominated by stopword-like matches (e.g. conversational logs).
  vector_weight?: number;
}

/**
 * Content search result with combined score and thread metadata
 */
export interface ContentSearchResult {
  id: number;
  entity_ids: number[];
  connection_id: number | null;
  payload_text: string;
  title: string | null;
  author_name: string | null;
  source_url: string | null;
  occurred_at: string | null;
  semantic_type: string;
  platform: string;
  origin_id: string;
  origin_parent_id: string | null;
  origin_type?: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty' | null;
  payload_data?: Record<string, unknown> | null;
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
  score: number;
  interaction_type?: 'none' | 'approval' | null;
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;

  metadata: any;
  classifications: any | null; // Only populated when include_classifications=true or filters applied
  created_at: string;
  similarity?: number; // Vector similarity score (0-1)
  text_rank?: number; // Full-text rank score
  combined_score: number; // Weighted combination of both

  // Thread metadata
  root_origin_id: string; // Thread root origin_id
  depth: number; // 0 = root, 1+ = nested
  parent_context?: {
    // Only if parent not in current results
    author_name: string;
    title: string | null;
    text_content: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  root_context?: {
    // Only if root not in results AND depth > 0
    author_name: string;
    title: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  cursor_fetched_count?: number | null;
}

export interface ContentSearchPageInfo {
  limit: number;
  offset: number;
  has_more: boolean;
  has_older?: boolean;
  has_newer?: boolean;
}

export interface ContentSearchResponse {
  content: ContentSearchResult[];
  total: number;
  page: ContentSearchPageInfo;
}

interface DateCursor {
  direction: 'before' | 'after';
  occurredAtIso: string;
  id: number;
}

function isDateFeedMode(options: ContentSearchOptions): boolean {
  return (options.sort_by ?? 'date') === 'date' && (options.sort_order ?? 'desc') === 'desc';
}

function parseCursorDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function resolveDateCursor(options: ContentSearchOptions): DateCursor | null {
  if (!isDateFeedMode(options)) return null;

  const beforeOccurredAt = parseCursorDate(options.before_occurred_at);
  if (beforeOccurredAt && options.before_id != null) {
    return {
      direction: 'before',
      occurredAtIso: beforeOccurredAt,
      id: options.before_id,
    };
  }

  const afterOccurredAt = parseCursorDate(options.after_occurred_at);
  if (afterOccurredAt && options.after_id != null) {
    return {
      direction: 'after',
      occurredAtIso: afterOccurredAt,
      id: options.after_id,
    };
  }

  return null;
}

function buildDateCursorClause(
  cursor: DateCursor | null,
  occurredAtColumn: string,
  idColumn: string,
  baseParamIndex: number
): { sql: string; params: unknown[] } {
  if (!cursor) return { sql: '', params: [] };

  const occurredAtParam = `$${baseParamIndex}::timestamptz`;
  const idParam = `$${baseParamIndex + 1}::bigint`;

  if (cursor.direction === 'before') {
    return {
      sql: `AND (${occurredAtColumn} < ${occurredAtParam} OR (${occurredAtColumn} = ${occurredAtParam} AND ${idColumn} < ${idParam}))`,
      params: [cursor.occurredAtIso, cursor.id],
    };
  }

  return {
    sql: `AND (${occurredAtColumn} > ${occurredAtParam} OR (${occurredAtColumn} = ${occurredAtParam} AND ${idColumn} > ${idParam}))`,
    params: [cursor.occurredAtIso, cursor.id],
  };
}

function buildDateCandidateOrderBy(cursor: DateCursor | null, tableAlias: string): string {
  if (cursor?.direction === 'after') {
    return `${tableAlias}.occurred_at ASC, ${tableAlias}.id ASC`;
  }
  return `${tableAlias}.occurred_at DESC, ${tableAlias}.id DESC`;
}

function buildPageInfo(params: {
  limit: number;
  offset: number;
  total: number;
  returnedCount: number;
  useDateFeed: boolean;
  cursor: DateCursor | null;
  fetchedCount?: number | null;
}): ContentSearchPageInfo {
  if (params.useDateFeed) {
    const fetchedCount = Number(params.fetchedCount ?? 0);
    const hasOlder = params.cursor?.direction === 'after' ? true : fetchedCount > params.limit;
    const hasNewer =
      params.cursor?.direction === 'before'
        ? true
        : params.cursor?.direction === 'after'
          ? fetchedCount > params.limit
          : false;

    return {
      limit: params.limit,
      offset: 0,
      has_more: hasOlder,
      has_older: hasOlder,
      has_newer: hasNewer,
    };
  }

  return {
    limit: params.limit,
    offset: params.offset,
    has_more: params.offset + params.returnedCount < params.total,
  };
}

function buildThreadMetaCteSql(entityIdParam: string, resultSetAlias = 'result_set'): string {
  return `
    thread_chain AS (
      SELECT
        rs.id as content_id,
        f.origin_id,
        f.origin_parent_id,
        f.origin_id as root_origin_id,
        0 as depth,
        ARRAY[COALESCE(f.origin_id, CAST(f.id AS VARCHAR))] as path
      FROM ${resultSetAlias} rs
      JOIN current_event_records f ON f.id = rs.id

      UNION ALL

      SELECT
        tc.content_id,
        p.origin_id,
        p.origin_parent_id,
        p.origin_id as root_origin_id,
        tc.depth + 1,
        array_append(tc.path, COALESCE(p.origin_id, CAST(p.id AS VARCHAR)))
      FROM thread_chain tc
      JOIN current_event_records p ON tc.origin_parent_id = p.origin_id
      WHERE tc.origin_parent_id IS NOT NULL
        AND tc.depth < 25
        AND (${entityIdParam} IS NULL OR ${entityIdParam} = ANY(p.entity_ids))
        AND NOT (COALESCE(p.origin_id, CAST(p.id AS VARCHAR)) = ANY(tc.path))
    ),
    thread_meta AS (
      SELECT * FROM (
        SELECT
          content_id,
          root_origin_id,
          depth,
          ROW_NUMBER() OVER (PARTITION BY content_id ORDER BY depth DESC) as rn
        FROM thread_chain
      ) sub WHERE rn = 1
    )
  `;
}

function buildLatestClassificationsCteSql(resultSetAlias = 'result_set'): string {
  return `
    latest_classifications AS (
      SELECT * FROM (
        SELECT
          cc.event_id,
          ccv.classifier_id,
          cc."values",
          cc.confidences,
          cc.source,
          cc.is_manual,
          ROW_NUMBER() OVER (
            PARTITION BY cc.event_id, ccv.classifier_id
            ORDER BY
              CASE cc.source WHEN 'user' THEN 1 WHEN 'llm' THEN 2 ELSE 3 END,
              ccv.is_current DESC,
              ccv.version DESC,
              cc.created_at DESC
          ) as rn
        FROM event_classifications cc
        JOIN ${resultSetAlias} rs ON rs.id = cc.event_id
        JOIN event_classifier_versions ccv ON cc.classifier_version_id = ccv.id
      ) sub WHERE rn = 1
    )
  `;
}

function collectVersionIds(rows: unknown[], mapping: Map<string, number[]>): void {
  for (const row of rows as Array<{ slug: string; version_id: number | string }>) {
    const slug = String(row.slug);
    const versionId = typeof row.version_id === 'number' ? row.version_id : Number(row.version_id);
    if (Number.isNaN(versionId)) continue;
    const existing = mapping.get(slug);
    if (existing) {
      existing.push(versionId);
    } else {
      mapping.set(slug, [versionId]);
    }
  }
}

async function resolveClassifierVersionIds(
  sql: DbClient,
  filtersBySlug: Map<string, string[]>,
  entityId: number | undefined
): Promise<Map<string, number[]>> {
  const slugs = Array.from(filtersBySlug.keys())
    .map((slug) => String(slug).trim())
    .filter((slug) => slug.length > 0);

  if (slugs.length === 0) return new Map();

  const placeholders = slugs.map((_, index) => `$${index + 1}`).join(', ');
  const mapping = new Map<string, number[]>();

  if (entityId) {
    const entityRows = await sql.unsafe(
      `
      SELECT ccl.slug, ccv.id as version_id
      FROM event_classifiers ccl
      JOIN event_classifier_versions ccv ON ccv.classifier_id = ccl.id
      JOIN watchers i ON i.id = ccl.watcher_id
      WHERE ccv.is_current = true
        AND ccl.slug IN (${placeholders})
        AND $${slugs.length + 1} = ANY(i.entity_ids)
    `,
      [...slugs, entityId]
    );
    collectVersionIds(entityRows, mapping);
  }

  const missingSlugs = slugs.filter((slug) => !mapping.has(slug));
  if (missingSlugs.length > 0) {
    const globalPlaceholders = missingSlugs.map((_, index) => `$${index + 1}`).join(', ');
    const globalRows = await sql.unsafe(
      `
      SELECT ccl.slug, ccv.id as version_id
      FROM event_classifiers ccl
      JOIN event_classifier_versions ccv ON ccv.classifier_id = ccl.id
      WHERE ccv.is_current = true
        AND ccl.slug IN (${globalPlaceholders})
        AND ccl.watcher_id IS NULL
    `,
      missingSlugs
    );
    collectVersionIds(globalRows, mapping);
  }

  return mapping;
}

function buildClassificationExistsClauses(
  filtersBySlug: Map<string, string[]>,
  classifierVersionIds: Map<string, number[]>,
  classificationSource: 'user' | 'embedding' | 'llm' | undefined,
  baseParamIndex: number
): { clauses: string[]; params: any[] } | null {
  const clauses: string[] = [];
  const params: any[] = [];
  let paramIndex = baseParamIndex;

  let sourceCondition = '';
  if (classificationSource) {
    params.push(classificationSource);
    sourceCondition = ` AND cc.source = $${paramIndex}`;
    paramIndex++;
  }

  for (const [slug, values] of filtersBySlug.entries()) {
    const slugStr = String(slug);
    const valuesArr = Array.isArray(values) ? values.map((v) => String(v)) : [String(values)];

    if (valuesArr.length === 0) {
      logger.warn({ slug: slugStr }, 'Skipping empty values array for classification filter');
      continue;
    }

    const versionIds = (classifierVersionIds.get(slugStr) || []).filter(
      (value) => typeof value === 'number' && Number.isInteger(value)
    );
    if (versionIds.length === 0) {
      logger.warn({ slug: slugStr }, 'Skipping classification filter without current version');
      return null;
    }

    // Parameterize values array
    params.push(valuesArr);
    const valuesParamSQL = `$${paramIndex}::text[]`;
    paramIndex++;

    // Parameterize version IDs
    params.push(versionIds);
    const versionFilterSql = `cc.classifier_version_id = ANY($${paramIndex}::int[])`;
    paramIndex++;

    clauses.push(
      `
      EXISTS (
        SELECT 1 FROM event_classifications cc
        WHERE cc.event_id = f.id
          AND ${versionFilterSql}
          AND cc."values" && ${valuesParamSQL}
          ${sourceCondition}
      )
    `.trim()
    );
  }

  if (clauses.length === 0) {
    return null;
  }

  return { clauses, params };
}

/**
 * Aggregate classification rows into a keyed object in TypeScript.
 * Replaces PostgreSQL jsonb_object_agg with in-memory aggregation.
 */
function aggregateClassifications(
  rows: Array<{
    id: number;
    classifier_attribute_key: string | null;
    classifier_values: any;
    classifier_confidences: any;
    classifier_source: string | null;
    classifier_is_manual: boolean | null;
    [key: string]: any;
  }>
): Map<number, Record<string, any>> {
  const map = new Map<number, Record<string, any>>();
  for (const row of rows) {
    if (!row.classifier_attribute_key || row.classifier_values == null) continue;
    let obj = map.get(row.id);
    if (!obj) {
      obj = {};
      map.set(row.id, obj);
    }
    obj[row.classifier_attribute_key] = {
      values: row.classifier_values,
      confidences: row.classifier_confidences,
      source: row.classifier_source,
      is_manual: row.classifier_is_manual,
    };
  }
  return map;
}

async function listContentInternal(
  sql: DbClient,
  options: ContentSearchOptions & { offset?: number },
  limit: number,
  offset: number
): Promise<ContentSearchResponse> {
  const entityId = options.entity_id;
  const organizationId = options.organization_id;
  const useDateFeed = isDateFeedMode(options);
  const cursor = resolveDateCursor(options);
  const effectiveOffset = useDateFeed ? 0 : offset;
  const fetchLimit = useDateFeed ? limit + 1 : limit;

  const sinceDate = options.since ? parseDateAlias(options.since).date : null;
  const untilDate = options.until ? toEndOfDay(parseDateAlias(options.until).date) : null;
  const connectionIdsArray =
    options.connection_ids && options.connection_ids.length > 0 ? options.connection_ids : null;

  const orderByForResultSet = buildOrderByClause(
    options.sort_by,
    options.sort_order,
    'f',
    'result_set'
  );
  const orderByForFinalSelect = buildOrderByClause(
    options.sort_by,
    options.sort_order,
    'rs',
    'final_select'
  );

  const needClassifications =
    options.include_classifications ||
    (options.classification_filters && options.classification_filters.length > 0);

  const classificationFilters = options.classification_filters ?? [];
  const hasClassificationFilters = classificationFilters.length > 0;
  const filtersBySlug = hasClassificationFilters
    ? groupClassificationFilters(classificationFilters)
    : null;
  const threadMetaCteSql = buildThreadMetaCteSql('$1');
  const latestClassificationsCteSql = buildLatestClassificationsCteSql();

  const listExtraColumns =
    'NULL as similarity, NULL as text_rank, 0 as combined_score, rs.cursor_fetched_count';
  const mkFinalSelect = (withClassifications: boolean) =>
    buildFinalSelect({
      withClassifications,
      extraColumns: listExtraColumns,
      orderBy: orderByForFinalSelect,
    });

  if (hasClassificationFilters && filtersBySlug) {
    const classifierVersionIds = await resolveClassifierVersionIds(sql, filtersBySlug, entityId);
    const connectionFilterClause = buildConnectionFilter(connectionIdsArray);
    const excludeClause = buildExcludeWatcherClause(options.exclude_watcher_id);

    const baseConditions: string[] = [];
    const baseParams: any[] = [];

    if (entityId != null) {
      baseParams.push(entityId);
      baseConditions.push(entityLinkMatchSql(`$${baseParams.length}::bigint`));
    } else if (organizationId) {
      baseParams.push(organizationId);
      baseConditions.push(
        `f.entity_ids && ARRAY(SELECT id FROM entities WHERE organization_id = $${baseParams.length})::bigint[]`
      );
    }

    baseConditions.push(connectionFilterClause);

    if (options.platform) {
      baseParams.push(options.platform);
      baseConditions.push(`f.connector_key = $${baseParams.length}`);
    }
    if (sinceDate) {
      baseParams.push(sinceDate.toISOString());
      baseConditions.push(`f.occurred_at >= $${baseParams.length}`);
    }
    if (untilDate) {
      baseParams.push(untilDate.toISOString());
      baseConditions.push(`f.occurred_at <= $${baseParams.length}`);
    }
    if (options.window_id != null) {
      baseParams.push(options.window_id);
      baseConditions.push(
        `EXISTS (SELECT 1 FROM watcher_window_events iwf WHERE iwf.event_id = f.id AND iwf.window_id = $${baseParams.length})`
      );
    }
    if (options.engagement_min != null) {
      baseParams.push(options.engagement_min);
      baseConditions.push(`f.score >= $${baseParams.length}`);
    }
    if (options.engagement_max != null) {
      baseParams.push(options.engagement_max);
      baseConditions.push(`f.score <= $${baseParams.length}`);
    }
    if (options.semantic_type) {
      baseParams.push(options.semantic_type);
      baseConditions.push(`f.semantic_type = $${baseParams.length}`);
    }
    if (options.interaction_status) {
      baseParams.push(options.interaction_status);
      baseConditions.push(`f.interaction_status = $${baseParams.length}`);
    }

    const classificationExists = buildClassificationExistsClauses(
      filtersBySlug,
      classifierVersionIds,
      options.classification_source,
      baseParams.length + 1
    );
    if (!classificationExists) {
      return {
        content: [],
        total: 0,
        page: buildPageInfo({
          limit,
          offset: effectiveOffset,
          total: 0,
          returnedCount: 0,
          useDateFeed,
          cursor,
        }),
      };
    }

    baseConditions.push(...classificationExists.clauses);
    const whereSql = baseConditions.length > 0 ? baseConditions.join(' AND ') : '1=1';
    const allFilterParams = [...baseParams, ...classificationExists.params];

    const countResult = await sql.unsafe<{ total: number | string }>(
      `SELECT COUNT(*) as total FROM current_event_records f LEFT JOIN connections c ON c.id = f.connection_id WHERE ${whereSql} ${excludeClause}`,
      allFilterParams
    );
    const total = parseInt(String(countResult[0]?.total ?? '0'), 10);

    const cursorClause = buildDateCursorClause(
      cursor,
      'f.occurred_at',
      'f.id',
      allFilterParams.length + 1
    );
    const queryBaseParams = [...allFilterParams, ...cursorClause.params];
    const limitIndex = queryBaseParams.length + 1;
    const offsetIndex = queryBaseParams.length + 2;
    const ctes = needClassifications
      ? `${threadMetaCteSql},\n        ${latestClassificationsCteSql}`
      : threadMetaCteSql;

    const contentQuery = useDateFeed
      ? `
        WITH RECURSIVE candidate_set AS (
          SELECT
            f.id,
            f.occurred_at
          FROM current_event_records f
          LEFT JOIN connections c ON c.id = f.connection_id
          WHERE ${whereSql}
            ${excludeClause}
            ${cursorClause.sql}
          ORDER BY ${buildDateCandidateOrderBy(cursor, 'f')}
          LIMIT $${limitIndex}
        ),
        result_set AS (
          SELECT
            cs.id,
            (SELECT COUNT(*) FROM candidate_set) as cursor_fetched_count
          FROM candidate_set cs
          ORDER BY ${buildDateCandidateOrderBy(cursor, 'cs')}
          LIMIT ${limit}
        ),
        ${ctes}
        ${mkFinalSelect(!!needClassifications)}`
      : `
        WITH RECURSIVE result_set AS (
          SELECT
            f.id,
            NULL::bigint as cursor_fetched_count
          FROM current_event_records f
          LEFT JOIN connections c ON c.id = f.connection_id
          WHERE ${whereSql} ${excludeClause}
          ORDER BY ${orderByForResultSet}
          LIMIT $${limitIndex} OFFSET $${offsetIndex}
        ),
        ${ctes}
        ${mkFinalSelect(!!needClassifications)}`;

    const allParams = useDateFeed
      ? [...queryBaseParams, fetchLimit]
      : [...queryBaseParams, limit, effectiveOffset];
    const rawRows = (await sql.unsafe(contentQuery, allParams)) as any[];

    const content = needClassifications
      ? deduplicateWithClassifications(rawRows)
      : (rawRows as any as ContentSearchResult[]);

    return {
      content,
      total,
      page: buildPageInfo({
        limit,
        offset: effectiveOffset,
        total,
        returnedCount: content.length,
        useDateFeed,
        cursor,
        fetchedCount: rawRows[0]?.cursor_fetched_count,
      }),
    };
  }

  const connectionCondition = buildConnectionFilter(connectionIdsArray);
  const excludeClause = buildExcludeWatcherClause(options.exclude_watcher_id);
  const standardParams = buildStandardParams(options, { sinceDate, untilDate });
  const orgScope = buildOrgScopeWhere({
    entity_id: entityId,
    organization_id: organizationId,
    baseParamIndex: standardParams.length + 1,
  });
  const countParams = [...standardParams, ...orgScope.params];

  const countResult = await sql.unsafe(
    `SELECT COUNT(*) as total FROM current_event_records f
      LEFT JOIN connections c ON c.id = f.connection_id
      ${WINDOW_JOIN_SQL}
      WHERE ${STANDARD_WHERE_SQL}
        AND ${connectionCondition}
        ${excludeClause}
        ${orgScope.sql}`,
    countParams
  );
  const total = parseInt(String(countResult[0]?.total ?? '0'), 10);

  const ctes = needClassifications
    ? `${threadMetaCteSql},\n      ${latestClassificationsCteSql}`
    : threadMetaCteSql;

  const cursorClause = buildDateCursorClause(
    cursor,
    'f.occurred_at',
    'f.id',
    countParams.length + 1
  );
  const queryBaseParams = [...countParams, ...cursorClause.params];
  const limitIdx = queryBaseParams.length + 1;
  const offsetIdx = queryBaseParams.length + 2;
  const querySQL = useDateFeed
    ? `
      WITH RECURSIVE candidate_set AS (
        SELECT
          f.id,
          f.occurred_at
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${WINDOW_JOIN_SQL}
        WHERE ${STANDARD_WHERE_SQL}
          AND ${connectionCondition}
          ${excludeClause}
          ${orgScope.sql}
          ${cursorClause.sql}
        ORDER BY ${buildDateCandidateOrderBy(cursor, 'f')}
        LIMIT $${limitIdx}
      ),
      result_set AS (
        SELECT
          cs.id,
          (SELECT COUNT(*) FROM candidate_set) as cursor_fetched_count
        FROM candidate_set cs
        ORDER BY ${buildDateCandidateOrderBy(cursor, 'cs')}
        LIMIT ${limit}
      ),
      ${ctes}
      ${mkFinalSelect(!!needClassifications)}`
    : `
      WITH RECURSIVE result_set AS (
        SELECT
          f.id,
          NULL::bigint as cursor_fetched_count
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${WINDOW_JOIN_SQL}
        WHERE ${STANDARD_WHERE_SQL}
          AND ${connectionCondition}
          ${excludeClause}
          ${orgScope.sql}
        ORDER BY ${orderByForResultSet}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      ),
      ${ctes}
      ${mkFinalSelect(!!needClassifications)}`;

  const queryParams = useDateFeed
    ? [...queryBaseParams, fetchLimit]
    : [...queryBaseParams, limit, effectiveOffset];
  const rawRows = (await sql.unsafe(querySQL, queryParams)) as any[];

  const content = needClassifications
    ? deduplicateWithClassifications(rawRows)
    : (rawRows as any as ContentSearchResult[]);

  return {
    content,
    total,
    page: buildPageInfo({
      limit,
      offset: effectiveOffset,
      total,
      returnedCount: content.length,
      useDateFeed,
      cursor,
      fetchedCount: rawRows[0]?.cursor_fetched_count,
    }),
  };
}

/**
 * Search or list content with full-text search
 *
 * @param queryText - Search query (optional - if null/empty, just lists with filters)
 * @param options - Filter and pagination options
 * @returns Array of content with text rank scores (or just filtered list)
 *
 * @example
 * ```typescript
 * // List content
 * const results = await searchContentByText(null, { entity_id: 123, limit: 20 });
 *
 * // Search content
 * const results = await searchContentByText(
 *   "app crashes on startup",
 *   { entity_id: 123, limit: 20 }
 * );
 * ```
 */
function buildSearchDocumentExpr(alias: string): string {
  return `setweight(to_tsvector('english', COALESCE(${alias}.title, '')), 'A') || setweight(to_tsvector('english', COALESCE(${alias}.payload_text, '')), 'B')`;
}

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
const NORMALIZED_QUERY_SQL = `trim(regexp_replace(regexp_replace(lower($1), '\\m(${STOPWORDS.join('|')})\\M', ' ', 'g'), '[^a-z0-9\\s]+', ' ', 'g'))`;
const TSQUERY_SQL = `CASE WHEN NULLIF(${NORMALIZED_QUERY_SQL}, '') IS NOT NULL THEN to_tsquery('english', regexp_replace(${NORMALIZED_QUERY_SQL}, '\\s+', ' | ', 'g')) ELSE NULL END`;

async function searchContentBySingleQuery(
  sql: DbClient,
  queryText: string,
  options: ContentSearchOptions & { offset?: number },
  env?: Env
): Promise<ContentSearchResponse> {
  const entityId = options.entity_id;
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const useDateFeed = isDateFeedMode(options);
  const cursor = resolveDateCursor(options);
  const effectiveOffset = useDateFeed ? 0 : offset;
  const fetchLimit = useDateFeed ? limit + 1 : limit;
  const trimmedQuery = queryText.trim();

  let queryEmbedding: number[] | null = null;
  if (env?.EMBEDDINGS_SERVICE_URL) {
    try {
      const embeddings = await generateEmbeddings([trimmedQuery], env);
      queryEmbedding = embeddings[0] ?? null;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[content-search] Embedding generation failed, falling back to text-only search'
      );
    }
  }
  const hasEmbedding = queryEmbedding !== null;
  const minSimilarity = options.min_similarity ?? 0.3;

  const sinceDate = options.since ? parseDateAlias(options.since).date : null;
  const untilDate = options.until ? toEndOfDay(parseDateAlias(options.until).date) : null;
  const connectionIdsArray =
    options.connection_ids && options.connection_ids.length > 0 ? options.connection_ids : null;

  const needClassifications =
    options.include_classifications ||
    (options.classification_filters && options.classification_filters.length > 0);

  const connectionCondition = buildConnectionFilter(connectionIdsArray);
  const excludeClause = buildExcludeWatcherClause(options.exclude_watcher_id);

  const orgScope = buildOrgScopeWhere({
    entity_id: entityId,
    organization_id: options.organization_id,
    baseParamIndex: 11,
  });
  const baseParamIdx = 11 + orgScope.params.length;
  const vectorParamIdx = hasEmbedding ? baseParamIdx : null;

  const standardFiltersSQL = `($2::bigint IS NULL OR ${entityLinkMatchSql('$2::bigint')})
          AND ${connectionCondition}
          AND ($3::text IS NULL OR f.connector_key = $3::text)
          AND ($4::timestamptz IS NULL OR f.occurred_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR f.occurred_at <= $5::timestamptz)
          AND ($6::int IS NULL OR iwf.window_id = $6::int)
          AND ($7::numeric IS NULL OR f.score >= $7::numeric)
          AND ($8::numeric IS NULL OR f.score <= $8::numeric)
          AND ($9::text IS NULL OR f.semantic_type = $9::text)
          AND ($10::text IS NULL OR f.interaction_status = $10::text)
          ${excludeClause}
          ${orgScope.sql}`;

  const textDocumentExpr = buildSearchDocumentExpr('f');
  const resultDocumentExpr = buildSearchDocumentExpr('fi');
  const textMatchExpr = `(f.payload_text ILIKE '%' || $1 || '%' OR COALESCE(${textDocumentExpr} @@ ${TSQUERY_SQL}, false))`;
  const vecParam = vectorParamIdx ? `$${vectorParamIdx}::vector` : 'NULL::vector';
  const matchCondition = hasEmbedding
    ? `(${textMatchExpr} OR (f.embedding IS NOT NULL AND 1 - (f.embedding <=> ${vecParam}) >= ${minSimilarity}))`
    : textMatchExpr;

  const searchWhereSQL = `${matchCondition}
          AND ${standardFiltersSQL}`;

  const textRankExpr = `
    (CASE WHEN fi.payload_text ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0.0 END)
    + COALESCE(ts_rank_cd(${resultDocumentExpr}, ${TSQUERY_SQL}), 0)
  `;
  let similarityExpr: string;
  let combinedScoreExpr: string;
  let searchExtraColumns: string;
  let orderByExpr: string;
  let resultSetOrderBy: string;
  const preferChronologicalOrdering = options.sort_by === 'date';

  // Tiebreaker for score-sorted branches: (id % 997) spreads near-tied rows pseudo-uniformly
  // across the ID space so that near-duplicate content (e.g. LoCoMo conversation sessions) does
  // not collapse onto the most-recent cluster via the occurred_at/id fallback. The final
  // occurred_at/id tiebreaker stays for full determinism when hashes also collide.
  const outerScoreTiebreaker = '(f.id % 997) ASC, f.occurred_at DESC, f.id DESC';
  const innerScoreTiebreaker = '(fi.id % 997) ASC, fi.occurred_at DESC, fi.id DESC';

  if (hasEmbedding) {
    // Clamp to [0, 1] so callers can't accidentally invert the weighting.
    const vectorWeight = Math.max(0, Math.min(1, options.vector_weight ?? 0.6));
    const textWeight = 1 - vectorWeight;
    if (process.env.OWLETTO_DEBUG_SEARCH === '1') {
      logger.info(
        { vector_weight: vectorWeight, text_weight: textWeight, q: queryText.slice(0, 40) },
        '[content-search] weights'
      );
    }
    similarityExpr = `CASE WHEN fi.embedding IS NOT NULL THEN 1 - (fi.embedding <=> ${vecParam}) ELSE NULL END`;
    combinedScoreExpr = `COALESCE((${textRankExpr}) * ${textWeight} + (1 - (fi.embedding <=> ${vecParam})) * ${vectorWeight}, ${textRankExpr})`;
    searchExtraColumns =
      'rs.text_rank, rs.similarity, rs.combined_score, rs.total_count, rs.cursor_fetched_count';
    orderByExpr = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'rs', 'final_select')
      : `rs.combined_score DESC, ${outerScoreTiebreaker}`;
    resultSetOrderBy = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'filtered_ids', 'result_set')
      : `${combinedScoreExpr} DESC, ${innerScoreTiebreaker}`;
  } else {
    similarityExpr = 'NULL';
    combinedScoreExpr = textRankExpr;
    searchExtraColumns =
      'rs.text_rank, NULL as similarity, rs.text_rank as combined_score, rs.total_count, rs.cursor_fetched_count';
    orderByExpr = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'rs', 'final_select')
      : `rs.combined_score DESC, ${outerScoreTiebreaker}`;
    resultSetOrderBy = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'filtered_ids', 'result_set')
      : `${textRankExpr} DESC, ${innerScoreTiebreaker}`;
  }

  const searchFinalSelect = buildFinalSelect({
    withClassifications: !!needClassifications,
    extraColumns: searchExtraColumns,
    orderBy: orderByExpr,
  });

  const searchThreadCteSql = buildThreadMetaCteSql('$2');
  const latestClassificationsCteSql = buildLatestClassificationsCteSql();
  const ctes = needClassifications
    ? `${searchThreadCteSql},\n      ${latestClassificationsCteSql}`
    : searchThreadCteSql;

  const cursorBaseParamIdx = baseParamIdx + (hasEmbedding ? 1 : 0);
  const cursorClause = buildDateCursorClause(cursor, 'fi.occurred_at', 'fi.id', cursorBaseParamIdx);
  const limitParamIdx = cursorBaseParamIdx + cursorClause.params.length;
  const offsetParamIdx = limitParamIdx + 1;
  const querySQL = useDateFeed
    ? `
      WITH RECURSIVE filtered_ids AS (
        SELECT f.id, f.score, f.occurred_at, f.title, f.payload_text, f.embedding
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        LEFT JOIN watcher_window_events iwf
          ON iwf.event_id = f.id
          AND ($6::int IS NOT NULL)
          AND iwf.window_id = $6::int
        WHERE ${searchWhereSQL}
      ),
      full_count AS (
        SELECT COUNT(*) as total_count FROM filtered_ids
      ),
      candidate_set AS (
        SELECT
          fi.id,
          fi.occurred_at,
          ${textRankExpr} as text_rank,
          ${similarityExpr} as similarity,
          ${combinedScoreExpr} as combined_score
        FROM filtered_ids fi
        WHERE 1=1 ${cursorClause.sql}
        ORDER BY ${buildDateCandidateOrderBy(cursor, 'fi')}
        LIMIT $${limitParamIdx}
      ),
      result_set AS (
        SELECT
          cs.id,
          cs.text_rank,
          cs.similarity,
          cs.combined_score,
          (SELECT total_count FROM full_count) as total_count,
          (SELECT COUNT(*) FROM candidate_set) as cursor_fetched_count
        FROM candidate_set cs
        ORDER BY ${buildDateCandidateOrderBy(cursor, 'cs')}
        LIMIT ${limit}
      ),
      ${ctes}
      ${searchFinalSelect}`
    : `
      WITH RECURSIVE filtered_ids AS (
        SELECT f.id, f.score, f.occurred_at, f.title, f.payload_text, f.embedding
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        LEFT JOIN watcher_window_events iwf
          ON iwf.event_id = f.id
          AND ($6::int IS NOT NULL)
          AND iwf.window_id = $6::int
        WHERE ${searchWhereSQL}
      ),
      result_set AS (
        SELECT
          fi.id,
          ${textRankExpr} as text_rank,
          ${similarityExpr} as similarity,
          ${combinedScoreExpr} as combined_score,
          COUNT(*) OVER() as total_count,
          NULL::bigint as cursor_fetched_count
        FROM filtered_ids fi
        ORDER BY ${resultSetOrderBy}
        LIMIT $${limitParamIdx}
        OFFSET $${offsetParamIdx}
      ),
      ${ctes}
      ${searchFinalSelect}`;

  const queryParams: unknown[] = [
    trimmedQuery,
    entityId ?? null,
    options.platform ?? null,
    sinceDate?.toISOString() ?? null,
    untilDate?.toISOString() ?? null,
    options.window_id ?? null,
    options.engagement_min ?? null,
    options.engagement_max ?? null,
    options.semantic_type ?? null,
    options.interaction_status ?? null,
    ...orgScope.params,
    ...(hasEmbedding ? [toVectorLiteral(queryEmbedding!)] : []),
    ...cursorClause.params,
    ...(useDateFeed ? [fetchLimit] : [limit, effectiveOffset]),
  ];

  const rawRows = (await sql.unsafe(querySQL, queryParams)) as any[];
  const total = rawRows.length > 0 ? parseInt(String(rawRows[0].total_count ?? '0'), 10) : 0;
  const content = needClassifications
    ? deduplicateWithClassifications(rawRows)
    : (rawRows as any as ContentSearchResult[]);

  return {
    content,
    total,
    page: buildPageInfo({
      limit,
      offset: effectiveOffset,
      total,
      returnedCount: content.length,
      useDateFeed,
      cursor,
      fetchedCount: rawRows[0]?.cursor_fetched_count,
    }),
  };
}

export async function searchContentByText(
  queryText: string | null,
  options: ContentSearchOptions & { offset?: number },
  env?: Env
): Promise<ContentSearchResponse> {
  const sql = getDb();
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;

  if (!queryText || queryText.trim().length < 3) {
    return await listContentInternal(sql, options, limit, offset);
  }

  const queryVariants = expandSearchQueries(queryText, { maxVariants: 8 });
  let lastResult: ContentSearchResponse | null = null;

  for (const variant of queryVariants) {
    const result = await searchContentBySingleQuery(sql, variant, options, env);
    if (result.content.length > 0) {
      if (variant !== queryText.trim()) {
        logger.info(
          { originalQuery: queryText.trim(), fallbackQuery: variant },
          '[content-search] recovered results via fallback query variant'
        );
      }
      return result;
    }
    lastResult = result;
  }

  return (
    lastResult ?? {
      content: [],
      total: 0,
      page: { limit, offset, has_more: false },
    }
  );
}
