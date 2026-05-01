/**
 * Content Search Utilities
 *
 * Hybrid search: combines PostgreSQL ILIKE text matching with pgvector
 * cosine-distance semantic search when the embeddings service is available.
 * Falls back to ILIKE-only when embeddings cannot be generated.
 */

import { type DbClient, getDb, pgTextArray } from '../db/client';
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
import { validateNumericId } from './sql-validation';

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
 * Standard identity namespaces (mirror of IDENTITY in @lobu/connector-sdk).
 * Kept local so content-search.ts doesn't take a build-time dep on the SDK.
 *
 * Adding a namespace here is a three-step change:
 *   1. Add the key to `IDENTITY` in @lobu/connector-sdk so connectors can reference it.
 *   2. Add a partial BTREE index `idx_events_metadata_<ns>` in a migration
 *      (see db/migrations/20260419120000_add_event_identity_indexes.sql).
 *   3. Add the string to this list — `entityLinkMatchSql` will emit a UNION
 *      branch that uses the new index.
 *
 * Non-standard namespaces are intentionally unsupported at read time: without
 * a matching index the identity branch seq-scans `events`, which blows up the
 * entire content query. If a connector needs a new namespace, add the index.
 */
export const STANDARD_IDENTITY_NAMESPACES = [
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

/**
 * One identity claim for an entity — `(namespace, identifier)`.
 *
 * Used by `fetchEntityIdentityScopes` + `buildEntityLinkUnion` to skip the
 * UNION branches that would never match for this entity. On a 4.7GB events
 * table the empty-branches-still-cost-real-time issue is the difference
 * between 200ms and 1.2s on the candidate_set scan alone.
 */
export interface EntityIdentityScope {
  namespace: string;
  identifier: string;
}

/**
 * Pre-fetch the live `entity_identities` rows for one entity, restricted to
 * the namespaces we have backing indexes for (`STANDARD_IDENTITY_NAMESPACES`).
 *
 * Cheap: indexed scan via `idx_entity_identities_by_entity`. Typical entity
 * has 0-3 rows. Run once per request, not per query.
 */
export async function fetchEntityIdentityScopes(
  sql: DbClient,
  entityId: number
): Promise<EntityIdentityScope[]> {
  const rows = (await sql`
    SELECT namespace, identifier
    FROM entity_identities
    WHERE entity_id = ${entityId}
      AND deleted_at IS NULL
      AND namespace = ANY(${pgTextArray([...STANDARD_IDENTITY_NAMESPACES])}::text[])
  `) as Array<{ namespace: unknown; identifier: unknown }>;
  return rows.map((r) => ({
    namespace: String(r.namespace),
    identifier: String(r.identifier),
  }));
}

/**
 * Build the same `<alias>.id IN (UNION …)` predicate as `entityLinkMatchSql`,
 * but emit only the branches an entity actually needs.
 *
 * Differences from the legacy helper:
 *  - The direct `entity_ids @> ARRAY[N]` branch is always included.
 *  - One `metadata->>'<ns>' = $N` branch per pre-fetched scope (no JOIN to
 *    `entity_identities`; the identifier is bound as a parameter). For an
 *    entity with no identities, that's zero extra branches — Postgres only
 *    plans the direct scan.
 *  - Uses an inline `entityIdLiteral` (already validated as a numeric id) so
 *    the planner sees the actual id and picks the entity-specific GIN scan
 *    instead of building a generic plan.
 *
 * Identifier values are bound params (caller appends them to its params
 * array), defending against tampering even though `entity_identities` is
 * write-controlled.
 */
export function buildEntityLinkUnion(opts: {
  /** Already-validated entity id, will be inlined as `<id>::bigint`. */
  entityIdLiteral: number;
  scopes: EntityIdentityScope[];
  alias?: string;
  baseParamIndex: number;
}): { sql: string; params: string[] } {
  const alias = opts.alias ?? 'f';
  const direct = `SELECT e2.id FROM events e2 WHERE e2.entity_ids @> ARRAY[${opts.entityIdLiteral}::bigint]`;
  const params: string[] = [];
  let paramIndex = opts.baseParamIndex;

  // Skip namespaces we have no backing index for (e.g. anything outside
  // STANDARD_IDENTITY_NAMESPACES) — they'd seq-scan events. The fetch helper
  // already filters to the standard list, but we double-check here so a
  // future caller that builds scopes manually can't blow up the scan.
  const indexed = new Set<string>(STANDARD_IDENTITY_NAMESPACES);
  const scopeBranches: string[] = [];
  for (const scope of opts.scopes) {
    if (!indexed.has(scope.namespace)) continue;
    params.push(scope.identifier);
    scopeBranches.push(
      `SELECT e2.id FROM events e2 WHERE e2.metadata->>'${scope.namespace}' = $${paramIndex}`
    );
    paramIndex += 1;
  }

  const branches = [direct, ...scopeBranches].join('\n    UNION\n    ');
  return {
    sql: `${alias}.id IN (\n    ${branches}\n  )`,
    params,
  };
}

/**
 * Build the shared `WHERE` skeleton used by `listContentInternal` for both
 * its count and list queries.
 *
 * `entityLinkSql` is the per-request fragment for "which events belong to
 * this entity" — see `buildEntityLinkUnion`. Pre-computing it once and
 * passing it in avoids re-emitting (and re-planning) the 7-branch generic
 * UNION for every query.
 */
function buildStandardWhereSql(entityLinkSql: string): string {
  return `($1::bigint IS NULL OR ${entityLinkSql})
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
}

const WINDOW_JOIN_SQL = `LEFT JOIN watcher_window_events iwf
          ON iwf.event_id = f.id
          AND ($5::int IS NOT NULL)
          AND iwf.window_id = $5::int`;

/**
 * Build NOT EXISTS clause to exclude content already in any window for a given
 * watcher. The watcher id is both validated (integer check) and bound as a query
 * parameter — validation guards against obvious injection attempts and the
 * parameter binding is the real defense.
 *
 * @param excludeWatcherId - Watcher ID to exclude content for
 * @param baseParamIndex - Next 1-based `$N` index to allocate for bound params
 * @param tableAlias - Alias for the content table (default: 'f')
 * @returns `{ sql, params }` — empty strings/arrays when no filter is applied
 */
function buildExcludeWatcherClause(
  excludeWatcherId: number | undefined,
  baseParamIndex: number,
  tableAlias = 'f'
): { sql: string; params: unknown[] } {
  if (excludeWatcherId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(excludeWatcherId, 'exclude_watcher_id');
  return {
    sql: ` AND NOT EXISTS (
    SELECT 1 FROM watcher_window_events exc_iwe
    JOIN watcher_windows exc_iw ON exc_iw.id = exc_iwe.window_id
    WHERE exc_iwe.event_id = ${tableAlias}.id AND exc_iw.watcher_id = $${baseParamIndex}::bigint
  )`,
    params: [validated],
  };
}

/**
 * Build an org/workspace-scoping WHERE clause using EXISTS (no JOIN needed).
 * Returns an empty string when no scoping is needed (e.g. entity_id is set).
 * Assumes the query has `f` aliasing events and `c` aliasing connections.
 *
 * An event is in scope when ANY of these hold:
 *  - the event itself was stamped to the caller's org (`f.organization_id`),
 *  - one of its `entity_ids` belongs to the caller's org, or
 *  - the connection that produced it belongs to the caller's org.
 *
 * The bridge clauses cover events ingested into another org but cross-linked
 * to entities/connections here. Stand-alone events with no entity links and
 * no connection are still findable via the direct `f.organization_id` match.
 */
export function buildOrgScopeWhere(options: {
  entity_id?: number;
  organization_id?: string;
  baseParamIndex: number;
}): { sql: string; params: Array<string | number | null> } {
  if (options.entity_id || !options.organization_id) return { sql: '', params: [] };

  const p = `$${options.baseParamIndex}::text`;
  const directCond = `f.organization_id = ${p}`;
  const entityCond = `EXISTS (SELECT 1 FROM entities ent_org WHERE ent_org.id = ANY(f.entity_ids) AND ent_org.organization_id = ${p})`;
  const connCond = `c.organization_id = ${p}`;
  return {
    sql: `AND (${directCond} OR ${entityCond} OR ${connCond})`,
    params: [options.organization_id],
  };
}

/**
 * Build a connection-visibility WHERE clause that lives inline alongside the
 * other content filters, so the list and count queries don't need a separate
 * "which connection ids may I see?" round trip.
 *
 * Semantics (must match `getContent`'s legacy two-step flow):
 *  - Authed user: connections with `visibility='org' OR created_by = $userId`.
 *  - Unauthed:    connections with `visibility='org'`.
 *  - Soft-deleted connections (`deleted_at IS NOT NULL`) are excluded.
 *  - Events with `connection_id IS NULL` (system / non-connection events)
 *    are visible in both authed and unauthed cases.
 *
 * Returns an empty fragment when no scope is requested (callers like the
 * watcher-mode/condensation path that already select by other constraints).
 */
export function buildConnectionVisibilityClause(
  options: {
    organizationId?: string;
    userId?: string | null;
    baseParamIndex: number;
  },
  tableAlias: string = 'f'
): { sql: string; params: Array<string | number | null> } {
  if (!options.organizationId) return { sql: '', params: [] };

  const orgParam = `$${options.baseParamIndex}::text`;
  const userParam = `$${options.baseParamIndex + 1}::text`;
  return {
    sql: `AND (${tableAlias}.connection_id IS NULL OR ${tableAlias}.connection_id IN (
      SELECT vc.id FROM connections vc
      WHERE vc.organization_id = ${orgParam}
        AND vc.deleted_at IS NULL
        AND (vc.visibility = 'org' OR (${userParam} IS NOT NULL AND vc.created_by = ${userParam}))
    ))`,
    params: [options.organizationId, options.userId ?? null],
  };
}

/**
 * Search options for content vector search
 */
interface ContentSearchOptions {
  // Entity filtering
  entity_id?: number;
  organization_id?: string; // Required when entity_id is omitted (org-wide mode)

  connection_ids?: number[]; // Array of connection IDs to filter by
  /**
   * Connection-visibility scope. When set, the SQL WHERE clause inlines a
   * subquery that hides events from private connections the caller cannot
   * see. Replaces the older "look up excluded connection ids first, pass them
   * in as connection_ids" two-query dance that the gateway used to do.
   *
   * Authenticated callers pass their user id; unauth callers pass null.
   * Events with `connection_id IS NULL` are always visible.
   */
  visibility_scope?: { organizationId: string; userId: string | null };
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

  // Pre-computed embedding for the query. When provided, skips the text→embedding
  // regeneration step inside searchContentBySingleQuery — useful when the caller
  // already computed an embedding (e.g. search_knowledge receiving query_embedding).
  query_embedding?: number[];
}

/**
 * Content search result with combined score and thread metadata
 */
interface ContentSearchResult {
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

interface ContentSearchPageInfo {
  limit: number;
  offset: number;
  has_more: boolean;
  has_older?: boolean;
  has_newer?: boolean;
}

interface ContentSearchResponse {
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

function buildThreadMetaCteSql(
  entityIdParam: string,
  resultSetAlias = 'result_set',
  entityLinkSql?: string
): string {
  // Pre-built scope-aware fragment beats the legacy 7-branch UNION when the
  // caller has already pre-fetched scopes; fall back to the legacy form for
  // call sites that haven't been migrated yet.
  //
  // When `entityLinkSql` is provided, the caller has already inlined the
  // entity id (so there's no `$N IS NULL` guard needed). When it isn't
  // provided, we keep the legacy `(${entityIdParam} IS NULL OR …)` shape so
  // org-wide callers can pass `$1` and have it dynamically null-checked.
  const usePrebuilt = entityLinkSql !== undefined;
  const linkSql = entityLinkSql ?? entityLinkMatchSql(`${entityIdParam}::bigint`, 'p');
  const entityFilter = usePrebuilt ? linkSql : `(${entityIdParam} IS NULL OR ${linkSql})`;
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
        AND ${entityFilter}
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

  // Pre-fetch the entity's identity claims so the entity-link UNION only
  // emits branches for namespaces this entity actually has. For an entity
  // with 0 identities (~17% of the rows in real data) the legacy
  // 7-branch UNION takes ~1s on a 4.7GB events table even though every
  // branch returns 0 rows; the trimmed UNION takes ~200ms.
  const entityScopes: EntityIdentityScope[] =
    entityId != null ? await fetchEntityIdentityScopes(sql, entityId) : [];
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

    const baseConditions: string[] = [];
    const baseParams: any[] = [];

    // Pre-built entity-link fragment for thread_meta's recursive walk.
    // When entity_id is set we use the trimmed UNION; otherwise threadMeta
    // doesn't need an entity filter (org-wide listings already constrain
    // candidates upstream).
    let threadEntityLinkSql: string | undefined;
    if (entityId != null) {
      // Inline the entity id as a literal so the planner picks the
      // entity-specific GIN scan instead of building a generic plan that
      // ignores selectivity. The id is already a number from the typed
      // option; we further validate via validateNumericId below before
      // passing to buildEntityLinkUnion.
      const validatedId = validateNumericId(entityId, 'entity_id');
      const link = buildEntityLinkUnion({
        entityIdLiteral: validatedId,
        scopes: entityScopes,
        alias: 'f',
        baseParamIndex: baseParams.length + 1,
      });
      baseConditions.push(link.sql);
      baseParams.push(...link.params);
      // Same shape, alias `p`, for thread_meta's recursive parent walk.
      threadEntityLinkSql = buildEntityLinkUnion({
        entityIdLiteral: validatedId,
        scopes: entityScopes,
        alias: 'p',
        // params don't need fresh slots — they're the same identifier values
        // emitted by the outer `link` already in baseParams. We re-bind them
        // by reusing the same $N slots.
        baseParamIndex: baseParams.length - link.params.length + 1,
      }).sql;
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
    const filterParamsBeforeExclude = [...baseParams, ...classificationExists.params];
    const excludeClause = buildExcludeWatcherClause(
      options.exclude_watcher_id,
      filterParamsBeforeExclude.length + 1
    );
    const filterParamsBeforeVisibility = [...filterParamsBeforeExclude, ...excludeClause.params];
    const visibilityClause = buildConnectionVisibilityClause({
      organizationId: options.visibility_scope?.organizationId,
      userId: options.visibility_scope?.userId ?? null,
      baseParamIndex: filterParamsBeforeVisibility.length + 1,
    });
    const allFilterParams = [...filterParamsBeforeVisibility, ...visibilityClause.params];

    const countResult = await sql.unsafe<{ total: number | string }>(
      `SELECT COUNT(*) as total FROM current_event_records f LEFT JOIN connections c ON c.id = f.connection_id WHERE ${whereSql} ${excludeClause.sql} ${visibilityClause.sql}`,
      allFilterParams
    );
    const total = parseInt(String(countResult[0]?.total ?? '0'), 10);

    // Short-circuit on empty matches — same reasoning as the standard
    // branch: postgres.js extended protocol pays a real planner cost on
    // the heavy enrichment query even when server-side execution is fast.
    if (total === 0) {
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

    const cursorClause = buildDateCursorClause(
      cursor,
      'f.occurred_at',
      'f.id',
      allFilterParams.length + 1
    );
    const queryBaseParams = [...allFilterParams, ...cursorClause.params];
    const limitIndex = queryBaseParams.length + 1;
    const offsetIndex = queryBaseParams.length + 2;
    const validatedLimit = validateNumericId(limit, 'limit');
    const branchThreadMetaCteSql = buildThreadMetaCteSql(
      '$1',
      'result_set',
      threadEntityLinkSql
    );
    const ctes = needClassifications
      ? `${branchThreadMetaCteSql},\n        ${latestClassificationsCteSql}`
      : branchThreadMetaCteSql;

    const contentQuery = useDateFeed
      ? `
        WITH RECURSIVE candidate_set AS (
          SELECT
            f.id,
            f.occurred_at
          FROM current_event_records f
          LEFT JOIN connections c ON c.id = f.connection_id
          WHERE ${whereSql}
            ${excludeClause.sql}
            ${visibilityClause.sql}
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
          LIMIT ${validatedLimit}
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
          WHERE ${whereSql} ${excludeClause.sql} ${visibilityClause.sql}
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
  const standardParams = buildStandardParams(options, { sinceDate, untilDate });

  // Build the entity-link UNION fragment once so both list and count emit
  // identical SQL — same shape as before but with namespaces trimmed to the
  // entity's actual identities. Params slot right after $1-$10 standardParams.
  let standardEntityLinkSql: string;
  let standardEntityLinkParams: string[] = [];
  let standardEntityLinkSqlForP: string | undefined;
  if (entityId != null) {
    const validatedId = validateNumericId(entityId, 'entity_id');
    const link = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: entityScopes,
      alias: 'f',
      baseParamIndex: standardParams.length + 1,
    });
    standardEntityLinkSql = link.sql;
    standardEntityLinkParams = link.params;
    // thread_meta walks parents (alias `p`); reuse the same param slots so
    // the params array doesn't grow.
    standardEntityLinkSqlForP = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: entityScopes,
      alias: 'p',
      baseParamIndex: standardParams.length + 1,
    }).sql;
  } else {
    // Org-wide / no-entity path keeps the legacy 7-branch UNION because the
    // outer `($1::bigint IS NULL OR …)` short-circuits to true and the SQL
    // is never evaluated. Cheap.
    standardEntityLinkSql = entityLinkMatchSql('$1::bigint');
  }
  const standardWhereSql = buildStandardWhereSql(standardEntityLinkSql);

  const paramsAfterEntityLink = [...standardParams, ...standardEntityLinkParams];
  const orgScope = buildOrgScopeWhere({
    entity_id: entityId,
    organization_id: organizationId,
    baseParamIndex: paramsAfterEntityLink.length + 1,
  });
  const paramsBeforeExclude = [...paramsAfterEntityLink, ...orgScope.params];
  const excludeClause = buildExcludeWatcherClause(
    options.exclude_watcher_id,
    paramsBeforeExclude.length + 1
  );
  const paramsBeforeVisibility = [...paramsBeforeExclude, ...excludeClause.params];
  const visibilityClause = buildConnectionVisibilityClause({
    organizationId: options.visibility_scope?.organizationId,
    userId: options.visibility_scope?.userId ?? null,
    baseParamIndex: paramsBeforeVisibility.length + 1,
  });
  const countParams = [...paramsBeforeVisibility, ...visibilityClause.params];

  const countResult = await sql.unsafe(
    `SELECT COUNT(*) as total FROM current_event_records f
      LEFT JOIN connections c ON c.id = f.connection_id
      ${WINDOW_JOIN_SQL}
      WHERE ${standardWhereSql}
        AND ${connectionCondition}
        ${excludeClause.sql}
        ${visibilityClause.sql}
        ${orgScope.sql}`,
    countParams
  );
  const total = parseInt(String(countResult[0]?.total ?? '0'), 10);

  // Short-circuit on empty matches. Even with the trimmed entity-link UNION,
  // the enrichment query — recursive thread_meta + classifications +
  // parent/root LEFT JOINs — pays a real planner cost on a 4.7GB events
  // table when run via postgres.js's extended protocol. Empirically that's
  // ~3-4s of the request even when result_set is empty server-side. Better
  // to spend one extra round-trip on the cheap count and skip the heavy
  // query entirely when total=0.
  if (total === 0) {
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

  const standardThreadMetaCteSql = buildThreadMetaCteSql(
    '$1',
    'result_set',
    standardEntityLinkSqlForP
  );
  const ctes = needClassifications
    ? `${standardThreadMetaCteSql},\n      ${latestClassificationsCteSql}`
    : standardThreadMetaCteSql;

  const cursorClause = buildDateCursorClause(
    cursor,
    'f.occurred_at',
    'f.id',
    countParams.length + 1
  );
  const queryBaseParams = [...countParams, ...cursorClause.params];
  const limitIdx = queryBaseParams.length + 1;
  const offsetIdx = queryBaseParams.length + 2;
  const validatedLimit = validateNumericId(limit, 'limit');
  const querySQL = useDateFeed
    ? `
      WITH RECURSIVE candidate_set AS (
        SELECT
          f.id,
          f.occurred_at
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${WINDOW_JOIN_SQL}
        WHERE ${standardWhereSql}
          AND ${connectionCondition}
          ${excludeClause.sql}
          ${visibilityClause.sql}
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
        LIMIT ${validatedLimit}
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
        WHERE ${standardWhereSql}
          AND ${connectionCondition}
          ${excludeClause.sql}
          ${visibilityClause.sql}
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

  let queryEmbedding: number[] | null = options.query_embedding?.length
    ? options.query_embedding
    : null;
  if (!queryEmbedding && env?.EMBEDDINGS_SERVICE_URL) {
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
  // Clamp to [0, 1] so a caller can't produce an always-true / always-false
  // predicate with an out-of-range value. Non-numeric input falls back to the
  // default. The parameter is still bound (not interpolated) below for defense
  // in depth.
  const rawMinSimilarity = Number(options.min_similarity ?? 0.3);
  const minSimilarity = Number.isFinite(rawMinSimilarity)
    ? Math.max(0, Math.min(1, rawMinSimilarity))
    : 0.3;

  const sinceDate = options.since ? parseDateAlias(options.since).date : null;
  const untilDate = options.until ? toEndOfDay(parseDateAlias(options.until).date) : null;
  const connectionIdsArray =
    options.connection_ids && options.connection_ids.length > 0 ? options.connection_ids : null;

  const needClassifications =
    options.include_classifications ||
    (options.classification_filters && options.classification_filters.length > 0);

  const connectionCondition = buildConnectionFilter(connectionIdsArray);

  // Pre-fetch the entity's identity claims so the entity-link UNION trims
  // unused namespaces. Search path benefits even more than the chronological
  // path because filtered_ids re-evaluates on every query variant attempt.
  const searchEntityScopes: EntityIdentityScope[] =
    entityId != null ? await fetchEntityIdentityScopes(sql, entityId) : [];

  const orgScope = buildOrgScopeWhere({
    entity_id: entityId,
    organization_id: options.organization_id,
    baseParamIndex: 11,
  });
  // Exclude-watcher param slot sits immediately after orgScope so its $N index
  // is stable regardless of whether an embedding param follows.
  const excludeParamIdx = 11 + orgScope.params.length;
  const excludeClause = buildExcludeWatcherClause(
    options.exclude_watcher_id,
    excludeParamIdx
  );
  // Connection-visibility predicate. Same helper used by every other
  // get_content branch, so authed/unauthed/private/system-event semantics
  // are guaranteed identical across the search/text-query path and the
  // chronological list path.
  const visibilityParamIdx = excludeParamIdx + excludeClause.params.length;
  const visibilityClause = buildConnectionVisibilityClause({
    organizationId: options.visibility_scope?.organizationId,
    userId: options.visibility_scope?.userId ?? null,
    baseParamIndex: visibilityParamIdx,
  });
  const entityLinkParamIdx = visibilityParamIdx + visibilityClause.params.length;
  // Build entity-link UNION (alias `f` for filtered_ids; alias `p` for thread
  // walk). Params slot after visibility, before vector/min_similarity.
  let searchEntityLinkSql: string;
  let searchEntityLinkSqlForP: string | undefined;
  let searchEntityLinkParams: string[] = [];
  if (entityId != null) {
    const validatedId = validateNumericId(entityId, 'entity_id');
    const link = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: searchEntityScopes,
      alias: 'f',
      baseParamIndex: entityLinkParamIdx,
    });
    searchEntityLinkSql = link.sql;
    searchEntityLinkParams = link.params;
    searchEntityLinkSqlForP = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: searchEntityScopes,
      alias: 'p',
      baseParamIndex: entityLinkParamIdx,
    }).sql;
  } else {
    // Org-wide path keeps the legacy 7-branch UNION; outer NULL check
    // short-circuits when entity_id is absent.
    searchEntityLinkSql = entityLinkMatchSql('$2::bigint');
  }
  const baseParamIdx = entityLinkParamIdx + searchEntityLinkParams.length;
  const vectorParamIdx = hasEmbedding ? baseParamIdx : null;
  // Bind min_similarity as a numeric parameter after the vector slot (when
  // present) so a hostile float can't break out of the comparison expression.
  const minSimilarityParamIdx = baseParamIdx + (hasEmbedding ? 1 : 0);

  const standardFiltersSQL = `($2::bigint IS NULL OR ${searchEntityLinkSql})
          AND ${connectionCondition}
          AND ($3::text IS NULL OR f.connector_key = $3::text)
          AND ($4::timestamptz IS NULL OR f.occurred_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR f.occurred_at <= $5::timestamptz)
          AND ($6::int IS NULL OR iwf.window_id = $6::int)
          AND ($7::numeric IS NULL OR f.score >= $7::numeric)
          AND ($8::numeric IS NULL OR f.score <= $8::numeric)
          AND ($9::text IS NULL OR f.semantic_type = $9::text)
          AND ($10::text IS NULL OR f.interaction_status = $10::text)
          ${excludeClause.sql}
          ${visibilityClause.sql}
          ${orgScope.sql}`;

  const textDocumentExpr = buildSearchDocumentExpr('f');
  const resultDocumentExpr = buildSearchDocumentExpr('fi');
  // Guard ILIKE/tsquery on non-empty $1 so an embedding-only call (trimmedQuery='')
  // doesn't degenerate to ILIKE '%%' (matches everything) — we want the vector
  // branch to be the sole filter in that case.
  const textMatchExpr = `(LENGTH($1) > 0 AND (f.payload_text ILIKE '%' || $1 || '%' OR COALESCE(${textDocumentExpr} @@ ${TSQUERY_SQL}, false)))`;
  const vecParam = vectorParamIdx ? `$${vectorParamIdx}::vector` : 'NULL::vector';
  const minSimilarityParam = `$${minSimilarityParamIdx}::numeric`;
  const matchCondition = hasEmbedding
    ? `(${textMatchExpr} OR (f.embedding IS NOT NULL AND 1 - (f.embedding <=> ${vecParam}) >= ${minSimilarityParam}))`
    : textMatchExpr;

  const searchWhereSQL = `${matchCondition}
          AND ${standardFiltersSQL}`;

  const textRankExpr = `
    (CASE WHEN LENGTH($1) > 0 AND fi.payload_text ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0.0 END)
    + CASE WHEN LENGTH($1) > 0 THEN COALESCE(ts_rank_cd(${resultDocumentExpr}, ${TSQUERY_SQL}), 0) ELSE 0 END
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

  const searchThreadCteSql = buildThreadMetaCteSql(
    '$2',
    'result_set',
    searchEntityLinkSqlForP
  );
  const latestClassificationsCteSql = buildLatestClassificationsCteSql();
  const ctes = needClassifications
    ? `${searchThreadCteSql},\n      ${latestClassificationsCteSql}`
    : searchThreadCteSql;

  // When hasEmbedding, two params (vector + min_similarity) follow baseParamIdx;
  // otherwise neither is bound, so the cursor params resume at baseParamIdx.
  const cursorBaseParamIdx = baseParamIdx + (hasEmbedding ? 2 : 0);
  const cursorClause = buildDateCursorClause(cursor, 'fi.occurred_at', 'fi.id', cursorBaseParamIdx);
  const limitParamIdx = cursorBaseParamIdx + cursorClause.params.length;
  const offsetParamIdx = limitParamIdx + 1;
  const validatedLimit = validateNumericId(limit, 'limit');
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
        LIMIT ${validatedLimit}
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
    ...excludeClause.params,
    ...visibilityClause.params,
    ...searchEntityLinkParams,
    ...(hasEmbedding ? [toVectorLiteral(queryEmbedding!), minSimilarity] : []),
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
    // Vector-only path: when the caller supplied a pre-computed embedding but
    // no usable text query, run the single-query ranker with empty text so the
    // cosine-distance branch drives retrieval (text ILIKE/tsquery are guarded
    // on LENGTH($1) > 0 and won't match).
    if (options.query_embedding?.length) {
      return await searchContentBySingleQuery(sql, '', options, env);
    }
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
