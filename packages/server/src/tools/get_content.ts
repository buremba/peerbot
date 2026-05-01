/**
 * Tool: read_knowledge
 *
 * List or search content for an entity.
 * Provide `query` parameter to perform semantic/full-text search.
 * Omit `query` to list all content with filters.
 */

import type { ContentItem } from '@lobu/connector-sdk';
import { getNextWatcherGranularity, inferWatcherGranularityFromSchedule } from '@lobu/connector-sdk';
import { type Static, Type } from '@sinclair/typebox';
import { createDbClientFromEnv, type DbClient, getDb, pgTextArray } from '../db/client';
import type { Env } from '../index';
import {
  getNormalizedScoreContent,
  getNormalizedScoreContentCount,
} from '../utils/content-scoring';
import {
  buildConnectionVisibilityClause,
  buildEntityLinkUnion,
  fetchEntityIdentityScopes,
  searchContentByText,
} from '../utils/content-search';
import { parseDateAlias, toEndOfDay } from '../utils/date-aliases';
import { type DataSourceContext, executeDataSources } from '../utils/execute-data-sources';
import { parseJsonObject } from '../utils/json';
import logger from '../utils/logger';

/**
 * Build the common SELECT columns, JOINs, and classification subquery
 * used by both the content_ids and include_superseded query branches.
 */
function buildContentQuery(opts: {
  table: string;
  alias: string;
  where: string;
  orderBy: string;
  limit: number;
  offset: number;
}): string {
  const { table, alias: a, where, orderBy, limit, offset } = opts;
  return `
    SELECT
      ${a}.id,
      ${a}.entity_ids,
      ${a}.payload_text,
      ${a}.title,
      ${a}.author_name,
      ${a}.source_url,
      ${a}.occurred_at,
      ${a}.semantic_type,
      ${a}.origin_id,
      ${a}.origin_parent_id,
      COALESCE(${a}.origin_parent_id, ${a}.origin_id) as root_origin_id,
      CASE WHEN ${a}.origin_parent_id IS NULL THEN 0 ELSE 1 END as depth,
      ${a}.origin_type,
      ${a}.payload_type,
      ${a}.payload_data,
      ${a}.payload_template,
      ${a}.attachments,
      ${a}.score,
      ${a}.metadata,
      ${a}.created_at,
      COALESCE(${a}.connector_key, c.connector_key) as platform,
      ${a}.interaction_type,
      ${a}.interaction_status,
      ${a}.interaction_input_schema,
      ${a}.interaction_input,
      ${a}.interaction_output,
      ${a}.interaction_error,
      ${a}.supersedes_event_id,
      oc.client_name,
      COALESCE(
        cls.classifications,
        '{}'::jsonb
      ) as classifications
    FROM ${table} ${a}
    LEFT JOIN connections c ON c.id = ${a}.connection_id
    LEFT JOIN oauth_clients oc ON oc.id = ${a}.client_id
    LEFT JOIN (
      SELECT
        lc.event_id,
        jsonb_object_agg(
          fcl.attribute_key,
          jsonb_build_object(
            'values', lc."values",
            'confidences', lc.confidences,
            'source', lc.source,
            'is_manual', lc.is_manual
          )
        ) as classifications
      FROM latest_event_classifications lc
      JOIN event_classifiers fcl ON lc.classifier_id = fcl.id
      WHERE lc."values" IS NOT NULL
      GROUP BY lc.event_id
    ) cls ON cls.event_id = ${a}.id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit}
    OFFSET ${offset}
  `;
}

import { requireReadAccess } from '../utils/organization-access';
import { validateNumericId } from '../utils/sql-validation';
import {
  buildContentUrl,
  buildEventPermalink,
  type EntityInfo,
  getOrganizationSlug,
  getPublicWebUrl,
} from '../utils/url-builder';
import { getRecentFeedbackSummary } from '../utils/watcher-feedback';
import { getAvailableOperations, getPastReactionsSummary } from '../utils/watcher-reactions';
import { computePendingWindow, queryUncondensedWindows } from '../utils/window-utils';
import type { ToolContext } from './registry';

// ============================================
// Typebox Schema
// ============================================

export const GetContentSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        'Search query text (min 3 characters). If provided, performs semantic/full-text search. If omitted, lists content ordered by date.',
      minLength: 3,
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Entity ID to filter by. Required unless watcher_id is provided.',
    })
  ),
  watcher_id: Type.Optional(
    Type.Number({
      description:
        "Watcher ID to fetch content for. When provided, uses watcher's sources and computes pending window. Returns window_token for complete_window action.",
    })
  ),
  template_version_id: Type.Optional(
    Type.Number({
      description:
        "Pin to a specific watcher_versions.id when reading the prompt/schema. Workers receive this from runs.approved_input.version_id and pass it back so a group edit landing mid-run can't make extraction use a different schema. When omitted, defaults to the watcher's current_version_id.",
    })
  ),
  connection_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'Connection IDs to filter by',
    })
  ),
  platforms: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Platform types to filter by (reddit, trustpilot, etc.)',
    })
  ),
  window_id: Type.Optional(
    Type.Number({
      description: 'Watcher window ID to filter by (shows only content analyzed in this window)',
    })
  ),
  since: Type.Optional(
    Type.String({
      description:
        'Filter events published since this date. Supports: ISO 8601 ("2025-01-01"), named aliases ("yesterday", "last_week"), or relative ("7d", "30d", "1m", "1y"). When used with watcher_id, also sets window_start in the generated token.',
    })
  ),
  until: Type.Optional(
    Type.String({
      description:
        'Filter events published until this date. Supports: ISO 8601 ("2025-01-31"), named aliases ("today", "yesterday"), or relative ("7d", "30d", "1m", "1y"). When used with watcher_id, also sets window_end in the generated token.',
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description:
        'Minimum vector similarity threshold for semantic search (0.0-1.0, default: 0.6). Only used when query is provided.',
      minimum: 0.0,
      maximum: 1.0,
      default: 0.6,
    })
  ),
  vector_weight: Type.Optional(
    Type.Number({
      description:
        'Weight of vector similarity vs text rank in combined_score (0.0-1.0, default: 0.6). Higher values favor semantic match over keyword overlap. Only applies when a query and embeddings are both present.',
      minimum: 0.0,
      maximum: 1.0,
    })
  ),
  classification_filters: Type.Optional(
    Type.Record(Type.String(), Type.Array(Type.String()), {
      description:
        'Filter by classification values, e.g. {"sentiment": ["positive", "neutral"], "bug-severity": ["critical"]}',
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Number of results to return (default: 50, max: 2000)',
      default: 50,
    })
  ),
  offset: Type.Optional(
    Type.Number({
      description: 'Number of results to skip for pagination (default: 0)',
      default: 0,
    })
  ),
  before_occurred_at: Type.Optional(
    Type.String({
      description:
        'Chronological cursor anchor for older results. Pair with before_id. Only used when sort_by=date and sort_order=desc.',
    })
  ),
  before_id: Type.Optional(
    Type.Number({
      description:
        'Stable tie-breaker for before_occurred_at. Only used when sort_by=date and sort_order=desc.',
      minimum: 1,
    })
  ),
  after_occurred_at: Type.Optional(
    Type.String({
      description:
        'Chronological cursor anchor for newer results. Pair with after_id. Only used when sort_by=date and sort_order=desc.',
    })
  ),
  after_id: Type.Optional(
    Type.Number({
      description:
        'Stable tie-breaker for after_occurred_at. Only used when sort_by=date and sort_order=desc.',
      minimum: 1,
    })
  ),
  include_classification: Type.Optional(
    Type.String({
      description:
        'Include classification data. Use "summary" to include aggregated classification stats for filter UI.',
    })
  ),
  engagement_min: Type.Optional(
    Type.Number({
      description: 'Minimum engagement score (0-100)',
      minimum: 0,
      maximum: 100,
    })
  ),
  engagement_max: Type.Optional(
    Type.Number({
      description: 'Maximum engagement score (0-100)',
      minimum: 0,
      maximum: 100,
    })
  ),
  sort_by: Type.Optional(
    Type.Union([Type.Literal('date'), Type.Literal('score')], {
      description:
        'Sort content by: date (newest first) or score (cross-platform smart ranking). Search queries respect date sorting for chronological feed browsing; score sorting remains relevance-weighted. Default: score',
      default: 'score',
    })
  ),
  sort_order: Type.Optional(
    Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
      description: 'Sort order: asc (ascending) or desc (descending). Default: desc',
      default: 'desc',
    })
  ),
  include_superseded: Type.Optional(
    Type.Boolean({
      description:
        'When true and listing entity content without a query, include superseded historical events in addition to current records. Useful for explicit historical lookups such as original or previous values.',
      default: false,
    })
  ),
  classification_source: Type.Optional(
    Type.Union([Type.Literal('user'), Type.Literal('embedding'), Type.Literal('llm')], {
      description:
        'Filter content by classification source: user (manual), embedding (system), or llm (AI-generated)',
    })
  ),
  content_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        'Filter to specific content IDs. Useful for showing content linked to watcher analysis.',
    })
  ),
  exclude_watcher_id: Type.Optional(
    Type.Number({
      description:
        'Exclude content already analyzed in any window for this watcher. Returns only unprocessed content for client-driven watcher generation.',
    })
  ),
  semantic_type: Type.Optional(
    Type.String({
      description:
        'Filter by semantic type (e.g. note, summary, decision, observation). Matches the semantic_type set via save_knowledge.',
    })
  ),
  interaction_status: Type.Optional(
    Type.Union(
      [
        Type.Literal('pending'),
        Type.Literal('approved'),
        Type.Literal('rejected'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ],
      {
        description: 'Filter by interaction status (e.g. "pending" for pending approvals)',
      }
    )
  ),
  condensation: Type.Optional(
    Type.Boolean({
      description:
        'When true with watcher_id, returns condensation prompt and window_token for rolling up completed leaf windows instead of fetching new content.',
    })
  ),
});

type GetContentArgs = Static<typeof GetContentSchema>;

export function getIncludeSupersededValidationErrors(args: Partial<GetContentArgs>): string[] {
  const errors: string[] = [];

  if (!args.entity_id) {
    errors.push('entity_id is required');
  }
  if (args.query) {
    errors.push('query is not supported');
  }
  if (args.content_ids && args.content_ids.length > 0) {
    errors.push('content_ids is not supported');
  }
  if (args.sort_by === 'score') {
    errors.push('sort_by=score is not supported');
  }
  if (args.classification_source) {
    errors.push('classification_source is not supported');
  }
  if (args.classification_filters && Object.keys(args.classification_filters).length > 0) {
    errors.push('classification_filters is not supported');
  }
  if (args.before_occurred_at || args.before_id || args.after_occurred_at || args.after_id) {
    errors.push('cursor pagination is not supported');
  }
  if (args.condensation) {
    errors.push('condensation mode is not supported');
  }

  return errors;
}

// ============================================
// Type Definitions
// ============================================

export type { ContentItem };

/** Classifier configuration returned for watcher mode (for worker embedding generation) */
interface ClassifierConfig {
  slug: string;
  extraction_config: Record<string, unknown> | null;
  attribute_values: Record<
    string,
    {
      description?: string;
      examples?: string[];
      embedding?: number[] | null;
    }
  >;
}

import type { UnprocessedRange } from '../types/watchers';

interface GetContentResult {
  content: ContentItem[];
  total: number;
  page: {
    limit: number;
    offset: number;
    has_more: boolean;
    has_older?: boolean;
    has_newer?: boolean;
  };
  classification_stats?: {
    [classifierSlug: string]: {
      [value: string]: number;
    };
  };
  /**
   * Permalink for the entity-scoped events listing in the public web app.
   * LLM agents calling `read_knowledge` over MCP read this from the response
   * and format it into chat replies; there is no programmatic consumer in
   * this repo, but removing the field breaks that user-facing behavior.
   */
  view_url?: string;
  // Watcher-mode fields (only present when watcher_id is provided)
  window_token?: string;
  window_start?: string;
  window_end?: string;
  prompt_rendered?: string;
  extraction_schema?: Record<string, any>; // JSON Schema for expected LLM output
  sources?: Record<string, ContentItem[]>;
  classifiers?: ClassifierConfig[]; // Only present when watcher_id is provided
  // Unprocessed content summary (only when watcher_id provided without since/until)
  unprocessed_ranges?: UnprocessedRange[];
  // Reaction data (watcher-mode only)
  reactions_guidance?: string; // Template-defined guidance for reactions
  available_operations?: Array<{
    connection_id: number;
    operation_key: string;
    name: string;
    kind: 'read' | 'write';
    requires_approval: boolean;
  }>;
  // Total content stats for the full date range (watcher-mode only)
  // Helps agents estimate token requirements: ~4 chars per token
  total_count?: number;
  total_count_chars?: number;
  estimated_tokens?: number;
  token_warning?: string;
  // Entity summary: shows which entities results cluster around (org-wide search only)
  entity_summary?: Array<{
    entity_id: number;
    name: string;
    entity_type: string;
    result_count: number;
  }>;
  // Hints for the client
  hints?: string[];
  // Condensation mode fields (watcher-mode only)
  condensation_ready?: boolean;
  condensation_prompt_rendered?: string;
}

// ============================================
// Database Row Types (for query result typing)
// ============================================

/** Simple row with just an id field */
interface IdRow {
  id: number;
}

/** Row type for classification stats aggregation */
interface ClassificationStatsRow {
  classifier_slug: string;
  value: string;
  count: string | number;
}

/** Row type for raw content query results (union of all possible sources) */
interface ContentRow {
  id: number;
  entity_ids: number[] | string; // string from some query sources
  platform: string;
  origin_id?: string | null;
  semantic_type: string;
  origin_type?: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty' | null;
  payload_text?: string | null;
  payload_data?: Record<string, unknown> | null;
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
  author_name?: string | null;
  title: string | null;
  source_url?: string | null;
  score: number;
  metadata: Record<string, unknown> | null;
  classifications: Record<string, unknown> | null;
  created_at: string;
  occurred_at?: string | null;
  similarity?: number | null;
  text_rank?: number | null;
  combined_score?: number | null;
  score_breakdown?: Record<string, unknown> | null;
  origin_parent_id?: string | null;
  root_origin_id?: string;
  depth?: number;
  interaction_type?: 'none' | 'approval' | null;
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;
  parent_context?: Record<string, unknown> | null;
  root_context?: Record<string, unknown> | null;
  client_name?: string | null;
  cursor_fetched_count?: number | null;
}

function parseJson(value: unknown): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function parseEntityIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    return raw.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
  }
  return [];
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return value != null ? Number(value) : undefined;
}

function parseRecordArray(value: unknown): Record<string, unknown>[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item)
  );
}

// ============================================
// Main Function
// ============================================

export async function getContent(
  args: GetContentArgs,
  env: Env,
  ctx: ToolContext
): Promise<GetContentResult> {
  // Dual client: PG for auth, PG for data
  const pgSql = createDbClientFromEnv(env);
  const sql = getDb();
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);

  // Validate entity access if entity_id provided (auth query stays on PG)
  if (args.entity_id) {
    await requireReadAccess(pgSql, args.entity_id, ctx);
  }
  // Stats are now opt-in: callers must explicitly pass `include_classification=summary`
  // (the Atlas events page used to set this unconditionally, which fired a heavy
  // `WITH matching_content` CTE on every first paint — including empty entities).
  const includeClassificationSummary = !!args.include_classification
    ?.split(',')
    .map((v) => v.trim())
    .includes('summary');

  const limit = args.limit || 50;
  const offset = args.offset || 0;

  try {
    // If watcher_id is provided, use watcher-mode: fetch content for all sources and generate window_token
    if (args.watcher_id) {
      return await handleWatcherMode(args, env, sql);
    }

    const entityId = args.entity_id;
    const sinceDate = args.since ? parseDateAlias(args.since).date : null;
    const untilDate = args.until ? toEndOfDay(parseDateAlias(args.until).date) : null;

    // Run org-slug lookup and entity-info lookup in parallel — they're
    // independent and on a high-RTT DB the serial form pays the round-trip
    // twice. view_url builds from both, and we still want it populated for
    // LLM consumers reading `read_knowledge` over MCP.
    const [ownerSlug, entityInfoRaw] = await Promise.all([
      getOrganizationSlug(ctx.organizationId),
      entityId
        ? sql`
          SELECT
            e.id,
            et.slug AS entity_type,
            e.slug,
            e.parent_id,
            parent.slug as parent_slug,
            pet.slug as parent_entity_type,
            e.organization_id
          FROM entities e
          JOIN entity_types et ON et.id = e.entity_type_id
          LEFT JOIN entities parent ON e.parent_id = parent.id
          LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
          WHERE e.id = ${entityId}
        `
        : Promise.resolve([] as Array<Record<string, unknown>>),
    ]);

    let entityInfo: EntityInfo | null = null;
    if (entityId && entityInfoRaw.length > 0) {
      entityInfo = ownerSlug
        ? {
            ownerSlug,
            entityType: entityInfoRaw[0].entity_type as string,
            slug: entityInfoRaw[0].slug as string,
            parentType: (entityInfoRaw[0].parent_entity_type as string) ?? null,
            parentSlug: (entityInfoRaw[0].parent_slug as string) ?? null,
          }
        : null;
    }

    // Visibility scope is folded into the SQL WHERE clause of every list/count
    // path (chronological list, content_ids, include_superseded, score) via
    // `buildConnectionVisibilityClause`. The legacy two-step "find private
    // connections, then find visible connections" round-trip is gone; events
    // with `connection_id IS NULL` (system events) stay visible to authed and
    // unauthed callers alike.
    const visibilityScope = { organizationId: ctx.organizationId, userId: ctx.userId };

    // Log incoming classification filters for debugging
    if (args.classification_filters) {
      logger.debug(
        { classification_filters: args.classification_filters },
        '[get_content] Received classification_filters'
      );
    }

    const classificationFilters = args.classification_filters
      ? Object.entries(args.classification_filters).flatMap(([slug, values]) =>
          values.map((value) => ({ classifier_slug: String(slug), value: String(value) }))
        )
      : undefined;

    const platformFilters = (args.platforms ?? []).map((p) => String(p).trim()).filter(Boolean);

    let effectiveConnectionIds = args.connection_ids ? [...args.connection_ids] : undefined;

    let didPlatformFilter = false;
    if (platformFilters.length > 0) {
      didPlatformFilter = true;
      const placeholders = platformFilters.map((_, index) => `$${index + 2}`).join(', ');
      // When entity_id is provided, filter connections by feeds targeting that entity.
      // Otherwise, filter by organization.
      const platformQuery = entityId
        ? `SELECT DISTINCT c.id
           FROM connections c
           JOIN feeds f ON f.connection_id = c.id
           WHERE $1 = ANY(f.entity_ids)
             AND c.connector_key IN (${placeholders})
             AND c.deleted_at IS NULL
             AND f.deleted_at IS NULL`
        : `SELECT c.id
           FROM connections c
           WHERE c.organization_id = $1
             AND c.connector_key IN (${placeholders})
             AND c.deleted_at IS NULL`;
      const platformRows = await sql.unsafe(platformQuery, [
        entityId ?? ctx.organizationId,
        ...platformFilters,
      ]);
      const platformConnectionIds = (platformRows as unknown as IdRow[])
        .map((row) => Number(row.id))
        .filter((id) => !Number.isNaN(id));

      if (effectiveConnectionIds && effectiveConnectionIds.length > 0) {
        const platformConnectionSet = new Set(platformConnectionIds);
        effectiveConnectionIds = effectiveConnectionIds.filter((id) =>
          platformConnectionSet.has(id)
        );
      } else {
        effectiveConnectionIds = platformConnectionIds;
      }
    }

    const effectivePlatform = platformFilters.length === 1 ? platformFilters[0] : undefined;
    const shouldReturnEmpty =
      didPlatformFilter && (!effectiveConnectionIds || effectiveConnectionIds.length === 0);

    // Determine query strategy:
    // 0. If content_ids provided -> simple direct query by IDs (bypasses other filters except entity_id)
    // 1. If search query provided -> searchContentByText (chronological feed when sort_by=date+desc)
    // 2. If no query + sort_by=score -> use getNormalizedScoreContent
    // 3. If no query + sort_by=date -> use searchContentByText with date sorting
    let rawContent: ContentRow[];
    let total: number;
    let pageInfo: GetContentResult['page'] = {
      limit,
      offset,
      has_more: false,
    };

    if (shouldReturnEmpty) {
      const result: GetContentResult = {
        content: [],
        total: 0,
        page: {
          limit,
          offset,
          has_more: false,
        },
      };
      if (includeClassificationSummary) {
        result.classification_stats = {};
      }
      if (entityInfo) {
        result.view_url = buildContentUrl(
          entityInfo,
          {
            platform: effectivePlatform,
            since: args.since,
            until: args.until,
          },
          baseUrl
        );
      }
      return result;
    }

    if (args.include_superseded) {
      const validationErrors = getIncludeSupersededValidationErrors(args);
      if (validationErrors.length > 0) {
        throw new Error(
          `include_superseded is only supported for entity-scoped chronological listings: ${validationErrors.join('; ')}`
        );
      }
    }

    if (args.content_ids && args.content_ids.length > 0) {
      // Direct query by content IDs - simple and fast
      logger.info(`[get_content] Filtering by ${args.content_ids.length} specific content IDs`);

      // Ensure content_ids is a proper array of numbers (handle string input from JSON)
      const contentIdsArray = Array.isArray(args.content_ids)
        ? args.content_ids.map((id) => (typeof id === 'string' ? parseInt(id, 10) : id))
        : String(args.content_ids)
            .split(',')
            .map((id) => parseInt(id.trim(), 10))
            .filter((id) => !Number.isNaN(id));

      // Build parameterized IN clause for content IDs
      const idPlaceholders = contentIdsArray.map((_, i) => `$${i + 1}`).join(',');
      const queryParams: any[] = [...contentIdsArray];

      queryParams.push(ctx.organizationId);
      const orgScope = `AND f.organization_id = $${queryParams.length}::text`;

      let entityFilter = '';
      if (args.entity_id) {
        // Use the trimmed entity-link UNION when we know the entity id —
        // skips namespaces this entity doesn't claim. Identifier values are
        // bound params; entity id is inlined as a literal so the planner
        // sees the actual selectivity.
        const validatedId = validateNumericId(args.entity_id as number, 'entity_id');
        const scopes = await fetchEntityIdentityScopes(sql, validatedId);
        const link = buildEntityLinkUnion({
          entityIdLiteral: validatedId,
          scopes,
          alias: 'f',
          baseParamIndex: queryParams.length + 1,
        });
        entityFilter = ` AND ${link.sql}`;
        queryParams.push(...link.params);
      }

      // Visibility: hide events from connections the caller can't see. Inline,
      // shared with the count below.
      const visibility = buildConnectionVisibilityClause({
        organizationId: visibilityScope.organizationId,
        userId: visibilityScope.userId,
        baseParamIndex: queryParams.length + 1,
      });
      queryParams.push(...visibility.params);

      // Query content by IDs with classifications
      const result = await sql.unsafe(
        buildContentQuery({
          table: 'current_event_records',
          alias: 'f',
          where: `f.id IN (${idPlaceholders}) ${orgScope}${entityFilter} ${visibility.sql}`,
          orderBy: 'f.occurred_at DESC',
          limit,
          offset,
        }),
        queryParams
      );

      const countResult = await sql.unsafe(
        `
        SELECT COUNT(*) as total
        FROM current_event_records f
        WHERE f.id IN (${idPlaceholders})
          ${orgScope}
          ${entityFilter}
          ${visibility.sql}
      `,
        queryParams
      );

      rawContent = result as unknown as ContentRow[];
      total = Number(countResult[0]?.total ?? 0);
      pageInfo = {
        limit,
        offset,
        has_more: offset + rawContent.length < total,
      };
    } else if (args.include_superseded) {
      logger.info('[get_content] Listing content including superseded history');

      // Pre-fetch the entity's identity scopes once so the trimmed entity
      // link UNION skips namespaces this entity doesn't claim. Same pattern
      // as listContentInternal. Entity id is inlined as a literal, so it's
      // not a bound param here — identifier values are.
      const supersededValidatedId = validateNumericId(entityId as number, 'entity_id');
      const supersededScopes = await fetchEntityIdentityScopes(sql, supersededValidatedId);
      const supersededLink = buildEntityLinkUnion({
        entityIdLiteral: supersededValidatedId,
        scopes: supersededScopes,
        alias: 'e',
        baseParamIndex: 2, // org=$1; identifier params start at $2
      });

      const conditions: string[] = [
        'e.organization_id = $1',
        supersededLink.sql,
      ];
      const queryParams: Array<string | number | null> = [
        ctx.organizationId,
        ...supersededLink.params,
      ];
      let paramIndex = 2 + supersededLink.params.length;

      if (effectiveConnectionIds && effectiveConnectionIds.length > 0) {
        const placeholders = effectiveConnectionIds.map(() => `$${paramIndex++}`).join(',');
        conditions.push(`e.connection_id IN (${placeholders})`);
        queryParams.push(...effectiveConnectionIds);
      }
      if (effectivePlatform) {
        conditions.push(`COALESCE(e.connector_key, c.connector_key) = $${paramIndex}`);
        queryParams.push(effectivePlatform);
        paramIndex += 1;
      }
      if (sinceDate) {
        conditions.push(`e.occurred_at >= $${paramIndex}`);
        queryParams.push(sinceDate.toISOString());
        paramIndex += 1;
      }
      if (untilDate) {
        conditions.push(`e.occurred_at <= $${paramIndex}`);
        queryParams.push(untilDate.toISOString());
        paramIndex += 1;
      }
      if (args.window_id !== undefined) {
        conditions.push(
          `EXISTS (SELECT 1 FROM watcher_window_events iwf WHERE iwf.event_id = e.id AND iwf.window_id = $${paramIndex})`
        );
        queryParams.push(args.window_id);
        paramIndex += 1;
      }
      if (args.exclude_watcher_id !== undefined) {
        conditions.push(
          `NOT EXISTS (SELECT 1 FROM watcher_window_events exc_iwe JOIN watcher_windows exc_iw ON exc_iw.id = exc_iwe.window_id WHERE exc_iwe.event_id = e.id AND exc_iw.watcher_id = $${paramIndex})`
        );
        queryParams.push(args.exclude_watcher_id);
        paramIndex += 1;
      }
      if (args.engagement_min !== undefined) {
        conditions.push(`e.score >= $${paramIndex}`);
        queryParams.push(args.engagement_min);
        paramIndex += 1;
      }
      if (args.engagement_max !== undefined) {
        conditions.push(`e.score <= $${paramIndex}`);
        queryParams.push(args.engagement_max);
        paramIndex += 1;
      }
      if (args.semantic_type) {
        conditions.push(`e.semantic_type = $${paramIndex}`);
        queryParams.push(args.semantic_type);
        paramIndex += 1;
      }
      if (args.interaction_status) {
        conditions.push(`e.interaction_status = $${paramIndex}`);
        queryParams.push(args.interaction_status);
        paramIndex += 1;
      }

      // Visibility: events from connections the caller can't see drop out.
      // The clause is appended as an `AND (…)` fragment so it folds cleanly
      // into the existing `conditions.join(' AND ')`.
      const visibility = buildConnectionVisibilityClause(
        {
          organizationId: visibilityScope.organizationId,
          userId: visibilityScope.userId,
          baseParamIndex: paramIndex,
        },
        'e'
      );
      if (visibility.sql) {
        // strip the leading "AND " that buildConnectionVisibilityClause emits
        // since we're joining conditions with ' AND ' ourselves.
        conditions.push(visibility.sql.replace(/^AND\s+/, ''));
        queryParams.push(...visibility.params);
        paramIndex += visibility.params.length;
      }

      const orderDirection = args.sort_order === 'asc' ? 'ASC' : 'DESC';
      const orderBySql = `e.occurred_at ${orderDirection} NULLS LAST, e.id ${orderDirection}`;

      const result = await sql.unsafe(
        buildContentQuery({
          table: 'events',
          alias: 'e',
          where: conditions.join(' AND '),
          orderBy: orderBySql,
          limit,
          offset,
        }),
        queryParams
      );

      const countResult = await sql.unsafe(
        `
        SELECT COUNT(*) as total
        FROM events e
        LEFT JOIN connections c ON c.id = e.connection_id
        WHERE ${conditions.join(' AND ')}
      `,
        queryParams
      );

      rawContent = result as unknown as ContentRow[];
      total = Number(countResult[0]?.total ?? 0);
      pageInfo = {
        limit,
        offset,
        has_more: offset + rawContent.length < total,
      };
    } else if (args.sort_by === 'score' && entityId) {
      logger.info('[get_content] Using sophisticated multi-signal score ranking');

      const filters: Parameters<typeof getNormalizedScoreContent>[3] = {
        ...(effectiveConnectionIds?.length && { connection_ids: effectiveConnectionIds }),
        ...(effectivePlatform && { platform: effectivePlatform }),
        ...(sinceDate && { since: sinceDate }),
        ...(untilDate && { until: untilDate }),
        ...(args.engagement_min !== undefined && { engagement_min: args.engagement_min }),
        ...(args.engagement_max !== undefined && { engagement_max: args.engagement_max }),
        ...(args.window_id !== undefined && { window_id: args.window_id }),
        ...(args.exclude_watcher_id !== undefined && {
          exclude_watcher_id: args.exclude_watcher_id,
        }),
        ...(classificationFilters?.length && { classification_filters: classificationFilters }),
        ...(args.classification_source && { classification_source: args.classification_source }),
        ...(args.semantic_type && { semantic_type: args.semantic_type }),
        ...(args.interaction_status && { interaction_status: args.interaction_status }),
        visibility_scope: visibilityScope,
      };

      const [contentResult, countResult] = await Promise.all([
        getNormalizedScoreContent(entityId, limit, offset, filters),
        getNormalizedScoreContentCount(entityId, filters),
      ]);

      rawContent = contentResult;
      total = countResult;
      pageInfo = {
        limit,
        offset,
        has_more: offset + rawContent.length < total,
      };
    } else {
      logger.info(`[get_content] ${args.query ? 'Search query provided' : 'Listing content'}`);
      const result = await searchContentByText(
        args.query ?? null,
        {
          entity_id: args.entity_id,
          organization_id: !args.entity_id ? ctx.organizationId : undefined,
          connection_ids: effectiveConnectionIds,
          visibility_scope: visibilityScope,
          window_id: args.window_id,
          exclude_watcher_id: args.exclude_watcher_id,
          platform: effectivePlatform,
          since: args.since,
          until: args.until,
          engagement_min: args.engagement_min,
          engagement_max: args.engagement_max,
          min_similarity: args.min_similarity,
          include_classifications: true,
          classification_filters: classificationFilters,
          classification_source: args.classification_source,
          semantic_type: args.semantic_type,
          interaction_status: args.interaction_status,
          limit,
          offset,
          // When a query is provided and no explicit sort_by, rank by combined_score
          // (text + vector). Defaulting to 'date' here quietly bypasses semantic ranking
          // and orders results newest-first, which is not what most semantic callers want.
          // Callers can still request chronological by passing sort_by='date' explicitly.
          sort_by: args.sort_by || (args.query ? 'score' : 'date'),
          sort_order: args.sort_order,
          ...(args.vector_weight !== undefined && { vector_weight: args.vector_weight }),
          before_occurred_at: args.before_occurred_at,
          before_id: args.before_id,
          after_occurred_at: args.after_occurred_at,
          after_id: args.after_id,
        },
        env
      );
      rawContent = result.content;
      total = result.total;
      pageInfo = result.page;
    }

    // Optionally fetch classification statistics (aggregated across ALL matching content, not just paginated results)
    // NOTE: Stats are computed WITHOUT classification filters to show the full distribution (sticky stats)
    // This allows users to see all available values even when filtering, enabling informed filter choices
    let classificationStats: GetContentResult['classification_stats'] | undefined;
    if (includeClassificationSummary) {
      // Build dynamic WHERE conditions using inline SQL
      const conditions: string[] = ['1=1'];
      const params: any[] = [];
      let paramIndex = 1;

      if (args.entity_id) {
        // Use the trimmed UNION here too so the stats CTE doesn't pay for
        // namespaces the entity doesn't have. Identifier values are bound
        // params; entity id is inlined as a literal.
        const statsValidatedId = validateNumericId(args.entity_id as number, 'entity_id');
        const statsScopes = await fetchEntityIdentityScopes(sql, statsValidatedId);
        const statsLink = buildEntityLinkUnion({
          entityIdLiteral: statsValidatedId,
          scopes: statsScopes,
          alias: 'f',
          baseParamIndex: paramIndex,
        });
        conditions.push(statsLink.sql);
        params.push(...statsLink.params);
        paramIndex += statsLink.params.length;
      }
      if (effectiveConnectionIds && effectiveConnectionIds.length > 0) {
        // Parameterize — every other branch in this file does, and an
        // upstream schema relaxation shouldn't be the thing that turns this
        // into a string-concat injection sink.
        const placeholders = effectiveConnectionIds
          .map(() => `$${paramIndex++}`)
          .join(',');
        conditions.push(`f.connection_id IN (${placeholders})`);
        params.push(...effectiveConnectionIds);
      }
      if (effectivePlatform) {
        conditions.push(`COALESCE(f.connector_key, c.connector_key) = $${paramIndex++}`);
        params.push(effectivePlatform);
      }
      if (sinceDate) {
        conditions.push(`f.occurred_at >= $${paramIndex++}`);
        params.push(sinceDate.toISOString());
      }
      if (untilDate) {
        conditions.push(`f.occurred_at <= $${paramIndex++}`);
        params.push(untilDate.toISOString());
      }
      let windowJoinSql = '';
      if (args.window_id) {
        windowJoinSql = `JOIN watcher_window_events iwf ON iwf.event_id = f.id AND iwf.window_id = $${paramIndex}`;
        params.push(args.window_id);
        paramIndex++;
      }

      // Visibility: events from connections the caller can't see must not
      // skew the classification distribution.
      const statsVisibility = buildConnectionVisibilityClause({
        organizationId: visibilityScope.organizationId,
        userId: visibilityScope.userId,
        baseParamIndex: paramIndex,
      });
      if (statsVisibility.sql) {
        conditions.push(statsVisibility.sql.replace(/^AND\s+/, ''));
        params.push(...statsVisibility.params);
        paramIndex += statsVisibility.params.length;
      }

      // Stats query WITHOUT classification filters (to show full distribution)
      const statsQueryResult = await sql.unsafe(
        `
        WITH matching_content AS (
          SELECT f.id
          FROM current_event_records f
          LEFT JOIN connections c ON c.id = f.connection_id
          ${windowJoinSql}
          WHERE ${conditions.join(' AND ')}
        ),
        ranked_classifications AS (
          SELECT
            cc.event_id,
            ccv.classifier_id,
            cc."values",
            ROW_NUMBER() OVER (
              PARTITION BY cc.event_id, ccv.classifier_id
              ORDER BY
                CASE cc.source WHEN 'user' THEN 1 WHEN 'llm' THEN 2 ELSE 3 END,
                ccv.version DESC,
                cc.created_at DESC
            ) as rn
          FROM event_classifications cc
          JOIN matching_content mc ON mc.id = cc.event_id
          JOIN event_classifier_versions ccv ON cc.classifier_version_id = ccv.id
          WHERE ccv.is_current = true
        ),
        latest_classifications AS (
          SELECT event_id, classifier_id, "values"
          FROM ranked_classifications
          WHERE rn = 1
        )
        SELECT
          fcl.slug as classifier_slug,
          fcl.attribute_key,
          value::text as value,
          COUNT(*) as count
        FROM latest_classifications lc
        JOIN event_classifiers fcl ON lc.classifier_id = fcl.id
        CROSS JOIN unnest(lc."values") AS t(value)
        GROUP BY fcl.slug, fcl.attribute_key, value
        ORDER BY fcl.slug, count DESC
      `,
        params
      );

      // Transform to nested object structure: { classifier_slug: { value: count } }
      classificationStats = {};
      for (const row of statsQueryResult as unknown as ClassificationStatsRow[]) {
        (classificationStats[row.classifier_slug] ??= {})[row.value] = Number(row.count);
      }
    }

    // Fetch excerpts for evidence highlighting when filtering by a single classification value
    const excerptsMap = new Map<number, string>();
    if (classificationFilters?.length === 1 && rawContent.length > 0) {
      const { classifier_slug: classifierSlug, value: filterValue } = classificationFilters[0];
      const contentIds = rawContent.map((f) => f.id);
      const contentIdPlaceholders = contentIds.map((_, i) => `$${i + 3}`).join(',');
      const excerptsResult = await sql.unsafe(
        `
        SELECT
          cc.event_id,
          cc.excerpts::jsonb->>$1 as excerpt
        FROM event_classifications cc
        JOIN event_classifier_versions ccv ON cc.classifier_version_id = ccv.id
        JOIN event_classifiers cl ON ccv.classifier_id = cl.id
        WHERE cc.event_id IN (${contentIdPlaceholders})
          AND cl.slug = $2
          AND $1 = ANY(cc."values")
          AND cc.excerpts::jsonb ? $1
      `,
        [filterValue, classifierSlug, ...contentIds]
      );

      for (const row of excerptsResult as unknown as Array<{
        event_id: number;
        excerpt: string;
      }>) {
        if (row.excerpt) {
          excerptsMap.set(Number(row.event_id), row.excerpt);
        }
      }

      logger.debug(
        { classifierSlug, filterValue, excerptCount: excerptsMap.size },
        '[get_content] Fetched excerpts for evidence highlighting'
      );
    }

    // Batch-resolve client_name and parent_context in parallel — the two
    // queries are independent (one keys by event id, the other by origin_id)
    // and on a high-RTT DB the serial form pays the round-trip twice.
    const idsNeedingClientName = rawContent.filter((f) => !f.client_name).map((f) => f.id);
    const parentExternalIds = rawContent
      .filter(
        (f) => f.origin_parent_id && !rawContent.some((r) => r.origin_id === f.origin_parent_id)
      )
      .map((f) => f.origin_parent_id as string);
    const uniqueParentIds = [...new Set(parentExternalIds)];

    const [clientRows, parentRows] = await Promise.all([
      idsNeedingClientName.length > 0
        ? sql`
          SELECT e.id, oc.client_name
          FROM current_event_records e
          JOIN oauth_clients oc ON oc.id = e.client_id
          WHERE e.id = ANY(${`{${idsNeedingClientName.join(',')}}`}::bigint[])
            AND e.client_id IS NOT NULL
        `
        : Promise.resolve([] as Array<{ id: number; client_name: string }>),
      uniqueParentIds.length > 0
        ? sql`
          SELECT origin_id, author_name, title, payload_text, occurred_at, source_url, score
          FROM current_event_records
          WHERE origin_id = ANY(${pgTextArray(uniqueParentIds)}::text[])
            AND organization_id = ${ctx.organizationId}
          LIMIT ${uniqueParentIds.length}
        `
        : Promise.resolve([] as Array<Record<string, unknown>>),
    ]);

    const clientNameMap = new Map<number, string>();
    for (const row of clientRows) {
      clientNameMap.set(Number(row.id), String(row.client_name));
    }

    const parentContextMap = new Map<string, ContentItem['parent_context']>();
    for (const row of parentRows) {
      const text = String(row.payload_text ?? '');
      parentContextMap.set(String(row.origin_id), {
        author_name: String(row.author_name ?? ''),
        title: row.title ? String(row.title) : null,
        text_content: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        occurred_at: String(row.occurred_at ?? ''),
        source_url: String(row.source_url ?? ''),
        score: Number(row.score) || 0,
      });
    }

    // Map to the canonical content item shape used across the app.
    const contentItems: ContentItem[] = rawContent.map((f) => {
      const metadata = parseJsonObject(f.metadata);
      const classifications = parseJsonObject(f.classifications);

      return {
        id: f.id,
        entity_ids: parseEntityIds(f.entity_ids),
        platform: f.platform,
        origin_id: f.origin_id ?? '',
        semantic_type: f.semantic_type ?? 'content',
        origin_type: f.origin_type ?? null,
        payload_type: f.payload_type ?? 'text',
        payload_text: f.payload_text ?? '',
        payload_data: parseJsonObject(f.payload_data),
        payload_template: f.payload_template ? parseJsonObject(f.payload_template) : null,
        attachments: parseRecordArray(f.attachments),
        author_name: f.author_name ?? null,
        client_name: f.client_name ?? clientNameMap.get(f.id) ?? null,
        title: f.title,
        text_content: f.payload_text ?? '',
        rating: (metadata.rating as string) || null,
        source_url: f.source_url ?? null,
        score: Number(f.score) || 0,
        metadata,
        classifications,
        created_at: f.created_at,
        occurred_at: f.occurred_at || f.created_at,
        content_date: f.occurred_at || f.created_at,
        excerpt: excerptsMap.get(f.id),
        similarity: toNumberOrUndefined(f.similarity),
        text_rank: toNumberOrUndefined(f.text_rank),
        combined_score: toNumberOrUndefined(f.combined_score),
        score_breakdown: f.score_breakdown as ContentItem['score_breakdown'],
        origin_parent_id: f.origin_parent_id || null,
        root_origin_id: f.root_origin_id || f.origin_id || String(f.id),
        depth: f.depth ?? 0,
        interaction_type: f.interaction_type ?? undefined,
        interaction_status: f.interaction_status ?? undefined,
        interaction_input_schema: f.interaction_input_schema
          ? parseJsonObject(f.interaction_input_schema)
          : undefined,
        interaction_input: f.interaction_input ? parseJsonObject(f.interaction_input) : undefined,
        interaction_output: f.interaction_output
          ? parseJsonObject(f.interaction_output)
          : undefined,
        interaction_error: f.interaction_error ?? undefined,
        supersedes_event_id: f.supersedes_event_id == null ? null : Number(f.supersedes_event_id),
        parent_context:
          parentContextMap.get(f.origin_parent_id as string) ??
          (f.parent_context as ContentItem['parent_context']) ??
          null,
        root_context: f.root_context as ContentItem['root_context'],
        permalink: ownerSlug ? buildEventPermalink(ownerSlug, f.id, baseUrl) : null,
      };
    });

    const result: GetContentResult = {
      content: contentItems,
      total,
      page: pageInfo,
    };

    if (classificationStats) {
      result.classification_stats = classificationStats;
    }

    // Add view URL when an entity is in scope. Consumed by LLM agents over MCP.
    if (entityInfo) {
      result.view_url = buildContentUrl(
        entityInfo,
        {
          platform: effectivePlatform,
          since: args.since,
          until: args.until,
        },
        baseUrl
      );
    }

    // Entity summary: when searching org-wide (query provided, no entity_id/watcher_id)
    if (args.query && !args.entity_id && !args.watcher_id && contentItems.length > 0) {
      const entityCountMap = new Map<number, number>();
      for (const item of contentItems) {
        for (const eid of item.entity_ids) {
          entityCountMap.set(eid, (entityCountMap.get(eid) || 0) + 1);
        }
      }

      if (entityCountMap.size > 1) {
        const uniqueEntityIds = Array.from(entityCountMap.keys());
        const idList = `{${uniqueEntityIds.join(',')}}`;
        const entityRows = await sql`
          SELECT e.id, e.name, et.slug AS entity_type
          FROM entities e
          JOIN entity_types et ON et.id = e.entity_type_id
          WHERE e.id = ANY(${idList}::int[])
        `;

        const entitySummary = entityRows
          .map((row: any) => ({
            entity_id: Number(row.id),
            name: row.name as string,
            entity_type: row.entity_type as string,
            result_count: entityCountMap.get(Number(row.id)) || 0,
          }))
          .sort((a, b) => b.result_count - a.result_count)
          .slice(0, 20);

        result.entity_summary = entitySummary;
      }
    }

    // Hints for the client
    const hints: string[] = [];
    if (offset + contentItems.length < total) {
      hints.push(`${total - (offset + contentItems.length)} more results available.`);
    }
    if (result.entity_summary) {
      hints.push(`Results span ${result.entity_summary.length} entities. Use entity_id to focus.`);
    }
    if (hints.length > 0) result.hints = hints;

    return result;
  } catch (error) {
    logger.error({ err: error }, 'get_content error:');
    throw error;
  }
}

// ============================================
// Content Query (inlined from watcher-content-query)
// ============================================

import type { WatcherSource } from '../types/watchers';
import type { WindowTokenQueryParams } from '../utils/jwt';

interface ContentQueryParams {
  sources: WatcherSource[];
  window_start: string;
  window_end: string;
  query_params: WindowTokenQueryParams;
  organizationId: string;
  entityIds?: number[];
}

function buildContentQueryContext(params: ContentQueryParams): DataSourceContext {
  return {
    organizationId: params.organizationId,
    entityIds: params.entityIds,
    windowStart: params.window_start,
    windowEnd: params.window_end,
  };
}

async function queryContentData(
  sql: DbClient,
  params: ContentQueryParams
): Promise<{ sourcesContent: Record<string, unknown[]>; allContent: unknown[] }> {
  const results = await executeDataSources(params.sources, buildContentQueryContext(params), sql);

  const seen = new Set<number>();
  const allContent: unknown[] = [];

  for (const rows of Object.values(results)) {
    for (const row of rows) {
      const rec = row as Record<string, unknown>;
      const id = typeof rec.id === 'number' ? rec.id : Number(rec.id);
      if (Number.isFinite(id) && !seen.has(id)) {
        seen.add(id);
        allContent.push({
          id,
          entity_ids: rec.entity_ids,
          platform: rec.platform ?? rec.connector_key,
          origin_id: rec.origin_id as string,
          semantic_type: rec.semantic_type ?? 'content',
          origin_type: rec.origin_type ?? null,
          payload_type: rec.payload_type ?? 'text',
          payload_text: rec.payload_text ?? rec.text_content,
          payload_data: rec.payload_data ?? {},
          payload_template: rec.payload_template ?? null,
          attachments: parseRecordArray(rec.attachments),
          author_name: rec.author_name ?? rec.author,
          title: rec.title,
          text_content: rec.payload_text ?? rec.text_content,
          rating: (rec.metadata as Record<string, unknown>)?.rating || null,
          source_url: rec.source_url ?? rec.url,
          score: Number(rec.score) || 0,
          metadata: rec.metadata || {},
          classifications: {},
          created_at: rec.created_at,
          occurred_at: rec.occurred_at ?? rec.created_at,
          origin_parent_id: rec.origin_parent_id ?? null,
          root_origin_id: rec.origin_id as string,
          depth: 0,
        });
      }
    }
  }

  return { sourcesContent: results as Record<string, unknown[]>, allContent };
}

// ============================================
// Watcher Mode Handler
// ============================================

async function handleWatcherMode(
  args: GetContentArgs,
  env: Env,
  sql: DbClient
): Promise<GetContentResult> {
  const { generateWindowToken } = await import('../utils/jwt');

  const watcherId = args.watcher_id!;

  // Workers pass `template_version_id` (snapshotted at run-creation time)
  // so the prompt/schema we hand back matches the version this run was
  // queued for, even if the group has been edited since. The version row
  // is owned by the group root (watcher_id = i.watcher_group_id), and we
  // require it to live in the same group to prevent cross-watcher pinning.
  const pinnedVersionId = args.template_version_id ?? null;
  const watcherResult = await sql`
    SELECT
      i.id,
      i.entity_ids,
      i.sources,
      i.schedule,
      i.organization_id,
      cv.prompt as template_prompt,
      cv.extraction_schema as template_extraction_schema,
      cv.reactions_guidance,
      cv.condensation_prompt,
      cv.condensation_window_count,
      cv.version_sources,
      (SELECT COALESCE(json_agg(json_build_object('id', e.id, 'name', e.name, 'type', et.slug)), '[]'::json) FROM entities e JOIN entity_types et ON et.id = e.entity_type_id WHERE e.id = ANY(i.entity_ids)) as entities
    FROM watchers i
    LEFT JOIN watcher_versions cv
      ON cv.id = COALESCE(${pinnedVersionId}::bigint, i.current_version_id)
     AND cv.watcher_id = i.watcher_group_id
    WHERE i.id = ${watcherId}
    LIMIT 1
  `;

  if (watcherResult.length === 0) {
    throw new Error(`Watcher ${watcherId} not found`);
  }

  const watcher = watcherResult[0];

  const versionSources = parseJson(watcher.version_sources) || [];
  const watcherSources =
    versionSources.length > 0 ? versionSources : parseJson(watcher.sources) || [];
  const timeGranularity = inferWatcherGranularityFromSchedule(watcher.schedule as string | null);
  const templatePrompt = (watcher.template_prompt as string | null) ?? undefined;
  const templateExtractionSchema = parseJson(watcher.template_extraction_schema) ?? undefined;

  // ============================================
  // Condensation mode: return prompt for rolling up completed leaf windows
  // ============================================
  if (args.condensation) {
    const condensationPrompt = watcher.condensation_prompt as string | null;
    const condensationWindowCount = Number(watcher.condensation_window_count) || 4;

    if (!condensationPrompt) {
      throw new Error(
        `Watcher ${watcherId}'s template does not have a condensation_prompt configured. ` +
          'Update the template version with a condensation_prompt to enable condensation.'
      );
    }

    const uncondensedWindows = await queryUncondensedWindows(sql, watcherId);

    if (uncondensedWindows.length < condensationWindowCount) {
      return {
        content: [],
        total: 0,
        page: { limit: 0, offset: 0, has_more: false },
        condensation_ready: false,
        hints: [
          `Only ${uncondensedWindows.length} uncondensed windows available, need ${condensationWindowCount}. ` +
            'Complete more windows before condensation.',
        ],
      };
    }

    // Take the oldest N windows for condensation
    const sourceWindows = uncondensedWindows.slice(0, condensationWindowCount);
    const sourceWindowIds = sourceWindows.map((w) => w.id);

    // Build windows context for prompt template
    const windowsContext = sourceWindows.map((w) => ({
      ...w,
      extracted_data:
        typeof w.extracted_data === 'string' ? JSON.parse(w.extracted_data) : w.extracted_data,
    }));

    // Render condensation prompt — replace {{windows}} with JSON of window data.
    // JS String.replace does not recurse into the replacement string,
    // so content inside windowsJson cannot trigger further {{...}} matches.
    const windowsJson = JSON.stringify(windowsContext, null, 2);
    const condensationPromptRendered = condensationPrompt.replace(
      /\{\{\{?windows\}\}\}?/g,
      windowsJson
    );

    // Generate window token with rollup fields
    const windowStart = sourceWindows[0].window_start;
    const windowEnd = sourceWindows[sourceWindows.length - 1].window_end;

    const rollupGranularity = getNextWatcherGranularity(timeGranularity) ?? timeGranularity;

    const windowToken = await generateWindowToken(
      {
        watcher_id: watcherId,
        window_start: windowStart,
        window_end: windowEnd,
        granularity: rollupGranularity,
        sources: [],
        query_params: { limit: 0, offset: 0, sort_by: 'date', sort_order: 'desc' },
        content_count: 0,
        is_rollup: true,
        source_window_ids: sourceWindowIds,
        depth: 1,
      },
      env
    );

    return {
      content: [],
      total: 0,
      page: { limit: 0, offset: 0, has_more: false },
      condensation_ready: true,
      condensation_prompt_rendered: condensationPromptRendered,
      window_token: windowToken,
      window_start: windowStart,
      window_end: windowEnd,
      extraction_schema: templateExtractionSchema,
    };
  }

  const watcherEntityIds = parseEntityIds(watcher.entity_ids);
  let sources: WatcherSource[];
  if (watcherSources.length > 0) {
    sources = watcherSources;
  } else {
    sources = [{ name: 'content', query: 'SELECT * FROM events ORDER BY occurred_at DESC' }];
  }

  // Fetch classifiers attached to this watcher
  const classifiersResult = await sql`
    SELECT
      cc.slug,
      ccv.extraction_config,
      ccv.attribute_values
    FROM event_classifiers cc
    JOIN event_classifier_versions ccv ON cc.id = ccv.classifier_id AND ccv.is_current = true
    WHERE cc.watcher_id = ${watcherId}
    ORDER BY cc.slug
  `;

  const classifiers: ClassifierConfig[] = classifiersResult.map((row: any) => ({
    slug: row.slug as string,
    extraction_config: row.extraction_config as Record<string, unknown> | null,
    attribute_values: row.attribute_values as ClassifierConfig['attribute_values'],
  }));

  // Compute window dates - use since/until if provided, else compute pending window
  let windowStart: Date, windowEnd: Date;
  if (args.since && args.until) {
    // Use provided date range for the window
    windowStart = parseDateAlias(args.since).date;
    windowEnd = toEndOfDay(parseDateAlias(args.until).date);
  } else {
    ({ windowStart, windowEnd } = await computePendingWindow(sql, watcherId, timeGranularity));
  }

  // NOTE: Window creation is deferred to complete_window action
  // This allows batched processing where each batch creates its own window

  // Determine query params for deterministic re-query
  const contentLimit = Math.min(args.limit || 500, 2000); // Max 2000 per source
  const contentOffset = args.offset || 0;
  const queryParamsInner = {
    limit: contentLimit,
    offset: contentOffset,
    sort_by: args.sort_by || 'score',
    sort_order: args.sort_order || 'desc',
  };
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  const sourceEntityIds = watcherEntityIds;
  const entityIdPlaceholders = sourceEntityIds.map((_, i) => `$${i + 1}`).join(',');

  // Run content query and total stats in parallel
  const [contentData, totalStatsResult] = await Promise.all([
    queryContentData(sql, {
      sources,
      window_start: windowStartIso,
      window_end: windowEndIso,
      query_params: queryParamsInner,
      organizationId: watcher.organization_id as string,
      entityIds: watcherEntityIds,
    }),
    sql.unsafe(
      `
      SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(LENGTH(c.payload_text)), 0) as total_chars
      FROM current_event_records c
      WHERE c.entity_ids && ARRAY[${entityIdPlaceholders}]::bigint[]
        AND c.occurred_at >= $${sourceEntityIds.length + 1}
        AND c.occurred_at < $${sourceEntityIds.length + 2}
    `,
      [...sourceEntityIds, windowStartIso, windowEndIso]
    ),
  ]);
  const { sourcesContent, allContent } = contentData;
  const totalCount = Number(totalStatsResult[0]?.total_count || 0);
  const totalCountChars = Number(totalStatsResult[0]?.total_chars || 0);

  // Generate signed JWT window token with all query params
  // NOTE: window_id is NOT included - it will be created by complete_window
  // content_count is included for staleness detection
  const windowToken = await generateWindowToken(
    {
      watcher_id: watcherId,
      window_start: windowStartIso,
      window_end: windowEndIso,
      granularity: timeGranularity,
      sources,
      query_params: queryParamsInner,
      content_count: allContent.length,
    },
    env
  );

  // Render template prompt if available
  let promptRendered: string | undefined;
  if (templatePrompt) {
    const { renderPromptTemplate } = await import('../utils/template-renderer');

    const entities = Array.isArray(watcher.entities)
      ? watcher.entities
      : (parseJson(watcher.entities) ?? []);

    promptRendered = renderPromptTemplate(templatePrompt, {
      sources: sourcesContent as Record<string, ContentItem[]>,
      content: allContent as ContentItem[],
      entities,
    });
  }

  // Compute unprocessed ranges when no specific date range requested
  // This helps agents understand what months need processing
  let unprocessedRanges: UnprocessedRange[] | undefined;
  if (!args.since && !args.until) {
    // Query content and linked counts by month in parallel
    const [monthlyContent, monthlyLinked] = await Promise.all([
      sql.unsafe(
        `
        SELECT
          DATE_TRUNC('month', c.occurred_at) as month,
          COUNT(*) as total
        FROM current_event_records c
        WHERE c.entity_ids && ARRAY[${entityIdPlaceholders}]::bigint[]
        GROUP BY DATE_TRUNC('month', c.occurred_at)
        ORDER BY month
      `,
        sourceEntityIds
      ),
      sql.unsafe(
        `
        SELECT
          DATE_TRUNC('month', c.occurred_at) as month,
          COUNT(DISTINCT c.id) as linked
        FROM current_event_records c
        JOIN watcher_window_events iwc ON c.id = iwc.event_id
        JOIN watcher_windows iw ON iwc.window_id = iw.id
        WHERE c.entity_ids && ARRAY[${entityIdPlaceholders}]::bigint[]
          AND iw.watcher_id = $${sourceEntityIds.length + 1}
        GROUP BY DATE_TRUNC('month', c.occurred_at)
      `,
        [...sourceEntityIds, watcherId]
      ),
    ]);

    // Build a map of linked counts by month
    const linkedByMonth = new Map<string, number>();
    for (const row of monthlyLinked) {
      const monthKey = new Date(row.month as string).toISOString().slice(0, 7);
      linkedByMonth.set(monthKey, Number(row.linked));
    }

    // Build unprocessed ranges
    unprocessedRanges = [];
    for (const row of monthlyContent) {
      const monthDate = new Date(row.month as string);
      const monthKey = monthDate.toISOString().slice(0, 7);
      const total = Number(row.total);
      const linked = linkedByMonth.get(monthKey) || 0;
      const unprocessed = total - linked;

      // Calculate window boundaries for this month
      const rangeWindowStart = new Date(monthDate);
      const rangeWindowEnd = new Date(monthDate);
      rangeWindowEnd.setMonth(rangeWindowEnd.getMonth() + 1);
      rangeWindowEnd.setMilliseconds(-1); // End of last day of month

      let status: UnprocessedRange['status'];
      if (linked === 0) {
        status = 'unprocessed';
      } else if (unprocessed === 0) {
        status = 'complete';
      } else {
        status = 'partial';
      }

      unprocessedRanges.push({
        month: monthKey,
        window_start: rangeWindowStart.toISOString(),
        window_end: rangeWindowEnd.toISOString(),
        total_content: total,
        processed_content: linked,
        unprocessed_content: unprocessed,
        status,
      });
    }

    // Filter to only show ranges with unprocessed content
    const rangesWithUnprocessed = unprocessedRanges.filter((r) => r.unprocessed_content > 0);
    if (rangesWithUnprocessed.length > 0) {
      logger.info(
        `[get_content] Watcher ${watcherId} has ${rangesWithUnprocessed.length} months with unprocessed content`
      );
    }
  }

  // Build past reactions history for self-learning
  let pastReactions: string | undefined;
  const reactionsGuidance = (watcher.reactions_guidance as string) || undefined;
  let availableOperations:
    | Array<{
        connection_id: number;
        operation_key: string;
        name: string;
        kind: 'read' | 'write';
        requires_approval: boolean;
      }>
    | undefined;

  let pastFeedback: string | undefined;
  try {
    const [pastReactionsResult, operations, feedbackSummary] = await Promise.all([
      getPastReactionsSummary(watcherId, 30),
      getAvailableOperations(watcherEntityIds),
      getRecentFeedbackSummary(watcherId, 10),
    ]);
    pastReactions = pastReactionsResult;
    availableOperations = operations.length > 0 ? operations : undefined;
    pastFeedback = feedbackSummary;
  } catch (err) {
    logger.warn({ err }, '[get_content] Failed to fetch reaction data for watcher mode');
  }

  // Append past reactions, feedback, and guidance to the rendered prompt
  let enrichedPrompt = promptRendered;
  if (enrichedPrompt) {
    if (reactionsGuidance) {
      enrichedPrompt += `\n\n## Reactions Guidance\n${reactionsGuidance}`;
    }
    if (pastReactions) {
      enrichedPrompt += `\n\n${pastReactions}`;
    }
    if (pastFeedback) {
      enrichedPrompt += `\n\n${pastFeedback}`;
    }
  }

  return {
    content: allContent as ContentItem[],
    total: allContent.length,
    page: {
      limit: contentLimit,
      offset: contentOffset,
      has_more: contentOffset + allContent.length < totalCount,
    },
    window_token: windowToken,
    window_start: windowStartIso,
    window_end: windowEndIso,
    prompt_rendered: enrichedPrompt,
    extraction_schema: templateExtractionSchema,
    sources: sourcesContent as Record<string, ContentItem[]>,
    classifiers: classifiers.length > 0 ? classifiers : undefined,
    unprocessed_ranges: unprocessedRanges,
    reactions_guidance: reactionsGuidance,
    available_operations: availableOperations,
    // Total stats for the full date range (helps agents estimate tokens)
    total_count: totalCount,
    total_count_chars: totalCountChars,
    estimated_tokens: Math.ceil(totalCountChars / 4),
    token_warning:
      totalCountChars > 400_000
        ? `Content is ~${Math.ceil(totalCountChars / 4000)}k tokens. Consider reducing limit or date range.`
        : undefined,
  };
}
