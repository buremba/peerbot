/**
 * Tool: search_knowledge
 *
 * Search existing entities in the database.
 * Searches all entity types when entity_type not specified.
 * For new entities, use manage_entity action='create' and then manage_connections.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { entityLinkMatchSql, searchContentByText } from '../utils/content-search';
import { toVectorLiteral } from '../utils/entity-management';
import logger from '../utils/logger';
import { expandSearchQueries } from '../utils/query-expansion';
import { buildEntityUrl, getPublicWebUrl } from '../utils/url-builder';
import { getWorkspaceProvider } from '../workspace';
import type { ToolContext } from './registry';

// ============================================
// Typebox Schema
// ============================================

export const SearchSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: 'Search query (entity name). Required unless entity_id is provided.',
      minLength: 1,
    })
  ),
  entity_type: Type.Optional(
    Type.String({
      description: 'Entity type filter. If not provided, searches all entities.',
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Entity ID for direct lookup. Can be used instead of query for exact fetch.',
    })
  ),
  parent_id: Type.Optional(
    Type.Number({
      description: 'Filter by parent entity ID.',
    })
  ),
  market: Type.Optional(
    Type.String({
      description: 'Market/region code (ISO 3166-1 alpha-2)',
    })
  ),
  category: Type.Optional(
    Type.String({
      description: 'Filter by category metadata field',
    })
  ),
  fuzzy: Type.Optional(
    Type.Boolean({
      description: 'Enable fuzzy name matching',
      default: true,
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description: 'Minimum similarity threshold for fuzzy matching (0.0-1.0)',
      default: 0.3,
      minimum: 0,
      maximum: 1,
    })
  ),
  include_connections: Type.Optional(
    Type.Boolean({
      description: 'Include connection details in response (max 20, active first)',
      default: true,
    })
  ),
  include_content: Type.Optional(
    Type.Boolean({
      description:
        'Include semantic content search results alongside entity matches (default: true). Uses the query for vector similarity search across all content in the organization.',
      default: true,
    })
  ),
  content_limit: Type.Optional(
    Type.Number({
      description: 'Max content results when include_content is enabled (default: 5, max: 50)',
      default: 5,
      minimum: 1,
      maximum: 50,
    })
  ),
  query_embedding: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        'Embedding vector for semantic similarity search. When provided, results are ranked by cosine similarity.',
    })
  ),
  metadata_filter: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Filter entities by metadata key-value pairs (e.g. {"namespace": "agent:prefs"})',
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Max results (default: 5, max: 100)',
      minimum: 1,
      maximum: 100,
    })
  ),
});

export type SearchArgs = Static<typeof SearchSchema>;

// ============================================
// Type Definitions
// ============================================

// Unified entity with all fields (nulls where not applicable)
export interface Entity {
  id: number;
  type: string;
  name: string;
  slug: string;
  metadata: Record<string, any>;
  parent_id: number | null;
  parent_name: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  organization_slug: string | null;
  stats: {
    content_count: number;
    connection_count: number;
    active_connection_count: number;
    children_count: number; // child count for root entities
    watcher_count: number;
  };
  match_score: number;
  match_reason: string;
}

interface ConnectionInfo {
  connection_id: number;
  connector_key: string;
  display_name: string | null;
  status: string;
  config: Record<string, unknown>;
  entity_names?: string | null;
  created_at: string;
  updated_at: string | null;
  content_count: number;
}

interface EntityQueryRow {
  id: number;
  organization_id: string;
  name: string;
  entity_type: string;
  slug: string;
  metadata: Record<string, unknown> | null;
  parent_id: number | null;
  parent_name: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  content_count: number;
  connection_count: number;
  active_connection_count: number;
  children_count: number;
  watcher_count: number;
  match_score?: number;
  match_reason?: string;
  organization_slug?: string | null;
  vector_similarity?: number;
}

interface ChildEntityRow {
  id: number;
  name: string;
  entity_type: string;
  market: string | null;
  content_count: number;
}

export interface ContentSnippet {
  id: number;
  title: string | null;
  text_content: string;
  author_name: string | null;
  source_url: string | null;
  platform: string;
  occurred_at: string | null;
  similarity?: number;
  entity_ids: number[];
}

export interface UnifiedSearchResult {
  entity_type: string | null;
  entity: Entity | null;
  matches: Entity[];
  connections?: ConnectionInfo[];
  children?: Array<{
    id: number;
    name: string;
    type: string;
    market: string | null;
    content_count: number;
  }>;
  content?: ContentSnippet[];
  discovery_status?: 'not_found' | 'complete' | 'discovering';
  suggestion?: string;
  view_url?: string;
  existing_entities?: Array<{ entity_type: string; entities: Array<{ id: number; name: string }> }>;
  metadata: {
    total_matches: number;
    page_size: number;
  };
}

// ============================================
// Result Helpers
// ============================================

function emptyResult(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    entity_type: null,
    entity: null,
    matches: [],
    discovery_status: 'not_found',
    metadata: { total_matches: 0, page_size: 0 },
    ...overrides,
  };
}

function withContent<T extends UnifiedSearchResult>(result: T, content: ContentSnippet[]): T {
  if (content.length > 0) result.content = content;
  return result;
}

// ============================================
// Main Function
// ============================================

async function fetchContentSnippets(
  query: string | null,
  organizationId: string,
  contentLimit: number,
  env: Env,
  queryEmbedding?: number[]
): Promise<ContentSnippet[]> {
  const result = await searchContentByText(
    query,
    {
      organization_id: organizationId,
      limit: contentLimit,
      min_similarity: 0.4,
      query_embedding: queryEmbedding,
    },
    env
  );

  return result.content.map((c) => ({
    id: c.id,
    title: c.title,
    text_content:
      c.payload_text.length > 500 ? c.payload_text.slice(0, 500) + '...' : c.payload_text,
    author_name: c.author_name,
    source_url: c.source_url,
    platform: c.platform,
    occurred_at: c.occurred_at,
    similarity: c.similarity,
    entity_ids: Array.isArray(c.entity_ids) ? c.entity_ids.map(Number) : [],
  }));
}

export async function search(
  args: SearchArgs,
  env: Env,
  ctx: ToolContext
): Promise<UnifiedSearchResult> {
  const includeContent = args.include_content ?? true;
  const contentLimit = Math.min(args.content_limit ?? 5, 50);

  if (!ctx.organizationId) {
    return emptyResult({ suggestion: 'No accessible entities found in this workspace scope' });
  }

  // Validate: must have either query, ID, or embedding
  if (!args.query && !args.entity_id && !args.query_embedding?.length) {
    throw new Error('Must provide either query, entity_id, or query_embedding');
  }

  // Helper to run content search in parallel. Runs when we have either a text
  // query or a pre-computed embedding — forwarding the embedding lets the
  // content layer skip regenerating it from text.
  const hasContentSignal = Boolean(args.query || args.query_embedding?.length);
  const contentSearchPromise =
    includeContent && hasContentSignal
      ? fetchContentSnippets(
          args.query ?? null,
          ctx.organizationId,
          contentLimit,
          env,
          args.query_embedding
        ).catch((err) => {
          logger.warn(
            `[search] content search failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return [] as ContentSnippet[];
        })
      : Promise.resolve([] as ContentSnippet[]);

  // ========================================
  // ID-BASED LOOKUP (highest priority)
  // ========================================

  if (args.entity_id) {
    const [entity, contentSnippets] = await Promise.all([
      fetchEntityById(args.entity_id, env, ctx.organizationId),
      contentSearchPromise,
    ]);
    if (entity) {
      return withContent(await formatEntityResult([entity], args, ctx), contentSnippets);
    }
    return withContent(
      emptyResult({
        entity_type: args.entity_type || null,
        suggestion: `Entity with ID ${args.entity_id} not found`,
      }),
      contentSnippets
    );
  }

  // ========================================
  // TIER 1 CACHE: Name-based search
  // ========================================

  // Truncate query for search — long texts break websearch_to_tsquery and don't improve results
  const query = args.query ? args.query.slice(0, 200).trim() || null : null;
  if (!query && !args.query_embedding?.length) {
    throw new Error('Must provide a query or query_embedding');
  }

  logger.info(
    `[search] Querying entities for "${query ?? '(vector)'}" (entity_type=${args.entity_type}, fuzzy=${args.fuzzy}, market=${args.market}, has_embedding=${!!args.query_embedding})`
  );

  let [results, contentSnippets] = await Promise.all([
    queryEntities(query, args, env, ctx.organizationId),
    contentSearchPromise,
  ]);

  if (results.length === 0 && query && !args.query_embedding?.length) {
    const fallbackQueries = expandSearchQueries(query, { maxVariants: 8 }).slice(1);
    for (const fallbackQuery of fallbackQueries) {
      results = await queryEntities(
        fallbackQuery.slice(0, 200).trim() || null,
        args,
        env,
        ctx.organizationId
      );
      if (results.length > 0) {
        logger.info(
          `[search] Recovered entity matches for "${query}" via fallback variant "${fallbackQuery}"`
        );
        break;
      }
    }
  }

  if (results.length > 0) {
    return withContent(await formatEntityResult(results, args, ctx), contentSnippets);
  }

  // ========================================
  // NOT FOUND: Return empty result with existing entities for context
  // ========================================
  logger.info(`[search] No matches found for "${query}" in existing database`);

  const suggestionText =
    `No matches found for "${query}" in existing database.\n\n` +
    '**Next steps:**\n' +
    `1. Create the entity: manage_entity action='create' name='${query}' (optionally set entity_type, parent_id for hierarchy)\n` +
    "2. Create a connection: manage_connections action='create' connector_key='<connector>', then scope it with manage_feeds action='create_feed' entity_ids=[<entity_id>]\n" +
    '3. Wait for ingestion to start automatically, then discover watchers with list_watchers and inspect results with read_knowledge/get_watcher.\n\n' +
    '**Alternative:** If you know this entity should exist, verify the spelling or try a different search term.';

  // Fetch top entities per type so the LLM knows what exists
  const existing_entities = await fetchTopEntitiesByType(ctx.organizationId);

  return withContent(
    emptyResult({ suggestion: suggestionText, existing_entities }),
    contentSnippets
  );
}

// ============================================
// Workspace Context Helpers
// ============================================

async function fetchTopEntitiesByType(
  organizationId: string
): Promise<Array<{ entity_type: string; entities: Array<{ id: number; name: string }> }>> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, name, entity_type
    FROM entities
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
    ORDER BY (SELECT COUNT(*) FROM current_event_records ev WHERE ${sql.unsafe(entityLinkMatchSql('entities.id::bigint', 'ev'))}) DESC
    LIMIT 30
  `;

  const byType = new Map<string, Array<{ id: number; name: string }>>();
  for (const row of rows) {
    const type = row.entity_type as string;
    if (!byType.has(type)) byType.set(type, []);
    const list = byType.get(type)!;
    if (list.length < 5) {
      list.push({ id: Number(row.id), name: row.name as string });
    }
  }

  return [...byType.entries()].map(([entity_type, entities]) => ({ entity_type, entities }));
}

// ============================================
// Query Helper Functions
// ============================================

const ENTITY_SELECT_COLUMNS = `
  e.id, e.organization_id, e.name, e.entity_type, e.slug, e.metadata, e.parent_id,
  pe.name as parent_name, pe.slug as parent_slug, pe.entity_type as parent_entity_type,
  COALESCE((SELECT COUNT(*) FROM current_event_records ev WHERE ${entityLinkMatchSql('e.id::bigint', 'ev')}), 0) as content_count,
  COALESCE((
    SELECT COUNT(DISTINCT cn.connector_key)
    FROM feeds f
    JOIN connections cn ON cn.id = f.connection_id
    WHERE e.id = ANY(f.entity_ids)
      AND f.deleted_at IS NULL
      AND cn.deleted_at IS NULL
  ), 0) as connection_count,
  COALESCE((
    SELECT COUNT(DISTINCT cn.connector_key)
    FROM feeds f
    JOIN connections cn ON cn.id = f.connection_id
    WHERE e.id = ANY(f.entity_ids)
      AND f.deleted_at IS NULL
      AND cn.deleted_at IS NULL
      AND cn.status = 'active'
  ), 0) as active_connection_count,
  COALESCE((SELECT COUNT(*) FROM entities c WHERE c.parent_id = e.id), 0) as children_count,
  COALESCE((SELECT COUNT(*) FROM watchers i WHERE e.id = ANY(i.entity_ids)), 0) as watcher_count`;

const ENTITY_JOINS = `
  FROM entities e
  LEFT JOIN entities pe ON e.parent_id = pe.id`;

/**
 * Query entities by name with optional filters
 * - entity_type: filter by specific type
 * - parent_id: filter by specific parent
 * - category, market: additional filters
 * - query_embedding: vector similarity search
 * - metadata_filter: key-value metadata conditions
 * - organizationId: organization IDs the user can read from
 */
async function queryEntities(
  query: string | null,
  args: SearchArgs,
  _env: Env,
  organizationId: string
) {
  const sql = getDb();
  const fuzzyEnabled = args.fuzzy ?? true;
  const hasEmbedding = !!args.query_embedding?.length;
  const defaultLimit = hasEmbedding ? 20 : fuzzyEnabled ? 5 : 1;
  const limit = args.limit ?? defaultLimit;

  // Build dynamic WHERE conditions
  const conditions: string[] = ['e.deleted_at IS NULL'];
  const params: unknown[] = [];
  let paramIdx = 1;

  const addParam = (value: unknown): number => {
    params.push(value);
    return paramIdx++;
  };

  // Query text param — only push when we have a text query
  const queryParamIdx = query ? addParam(query) : null;

  // Embedding param — only push when we have an embedding (avoids null::vector type error)
  const embeddingParamIdx = hasEmbedding ? addParam(toVectorLiteral(args.query_embedding!)) : null;

  // Query match condition: text match OR vector match
  if (query) {
    if (fuzzyEnabled) {
      const textCondition = `(LOWER(e.name) LIKE '%' || LOWER($${queryParamIdx}) || '%' OR LOWER(e.name) = LOWER($${queryParamIdx}) OR similarity(LOWER(e.name), LOWER($${queryParamIdx})) > 0.3 OR e.content_tsv @@ websearch_to_tsquery('english', $${queryParamIdx}))`;
      conditions.push(
        hasEmbedding ? `(${textCondition} OR e.embedding IS NOT NULL)` : textCondition
      );
    } else {
      conditions.push(`LOWER(e.name) = LOWER($${queryParamIdx})`);
    }
  } else if (hasEmbedding) {
    conditions.push('e.embedding IS NOT NULL');
  }

  // Organization filter
  conditions.push(`e.organization_id = $${addParam(organizationId)}`);

  if (args.entity_type) conditions.push(`e.entity_type = $${addParam(args.entity_type)}`);
  if (args.parent_id) conditions.push(`e.parent_id = $${addParam(args.parent_id)}`);
  if (args.category)
    conditions.push(`e.metadata::jsonb->>'category' = $${addParam(args.category)}`);
  if (args.market) {
    const idx = addParam(args.market);
    conditions.push(
      `(e.metadata::jsonb->>'main_market' = $${idx} OR e.metadata::jsonb->>'market' = $${idx})`
    );
  }

  // Metadata filter: arbitrary key-value conditions
  if (args.metadata_filter) {
    for (const [key, value] of Object.entries(args.metadata_filter)) {
      conditions.push(`e.metadata->>'${key.replace(/'/g, "''")}' = $${addParam(value)}`);
    }
  }

  const whereClause = conditions.join(' AND ');

  // Build scoring expression
  let scoreExpr: string;
  let matchReason: string;
  let vectorSimExpr: string;

  if (hasEmbedding) {
    // Blended scoring: 0.6 vector + 0.3 text + 0.1 name
    vectorSimExpr = `CASE WHEN e.embedding IS NOT NULL THEN 1 - (e.embedding <=> $${embeddingParamIdx}::vector) ELSE 0 END`;
    const textRankExpr =
      queryParamIdx !== null
        ? `COALESCE(ts_rank_cd(e.content_tsv, websearch_to_tsquery('english', $${queryParamIdx})), 0)`
        : '0';
    const nameSimExpr =
      queryParamIdx !== null ? `similarity(LOWER(e.name), LOWER($${queryParamIdx}))` : '0';
    scoreExpr = `(${vectorSimExpr}) * 0.6 + (${textRankExpr}) * 0.3 + (${nameSimExpr}) * 0.1`;
    matchReason = 'vector_blend';
  } else if (fuzzyEnabled && queryParamIdx !== null) {
    vectorSimExpr = 'NULL';
    scoreExpr = `CASE WHEN LOWER(e.name) = LOWER($${queryParamIdx}) THEN 1.0 ELSE similarity(LOWER(e.name), LOWER($${queryParamIdx})) END`;
    matchReason = 'fuzzy_match';
  } else {
    vectorSimExpr = 'NULL';
    scoreExpr = '1.0';
    matchReason = 'exact_name';
  }

  const rows = await sql.unsafe<EntityQueryRow>(
    `SELECT ${ENTITY_SELECT_COLUMNS},
      ${scoreExpr} as match_score,
      '${matchReason}' as match_reason,
      ${vectorSimExpr} as vector_similarity
    ${ENTITY_JOINS}
    WHERE ${whereClause}
    ORDER BY match_score DESC
    LIMIT ${limit}`,
    params
  );

  await attachOrganizationSlugs(rows);

  return rows;
}

async function fetchEntityById(entityId: number, _env: Env, organizationId: string) {
  const sql = getDb();

  const result = await sql.unsafe<EntityQueryRow>(
    `SELECT ${ENTITY_SELECT_COLUMNS}
    ${ENTITY_JOINS}
    WHERE e.id = $1
      AND e.organization_id = $2
      AND e.deleted_at IS NULL`,
    [entityId, organizationId]
  );

  if (result.length === 0) return null;

  await attachOrganizationSlugs(result);
  return result[0];
}

// ============================================
// Formatting Helper Functions
// ============================================

async function formatEntityResult(
  entityRows: EntityQueryRow[],
  args: SearchArgs,
  ctx: ToolContext
): Promise<UnifiedSearchResult> {
  // Map rows to unified Entity format (all fields, nulls where not applicable)
  const matches: Entity[] = entityRows.map((row) => ({
    id: Number(row.id),
    type: row.entity_type,
    name: row.name,
    slug: row.slug,
    metadata: row.metadata ?? {},
    parent_id: row.parent_id != null ? Number(row.parent_id) : null,
    parent_name: row.parent_name ?? null,
    parent_slug: row.parent_slug ?? null,
    parent_entity_type: row.parent_entity_type ?? null,
    organization_slug: row.organization_slug ?? null,
    stats: {
      content_count: Number(row.content_count) || 0,
      connection_count: Number(row.connection_count) || 0,
      active_connection_count: Number(row.active_connection_count) || 0,
      children_count: Number(row.children_count) || 0,
      watcher_count: Number(row.watcher_count) || 0,
    },
    match_score: Number(row.match_score) || 1.0,
    match_reason: row.match_reason || 'exact_name',
  }));

  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  const primaryEntity = matches[0];
  const entityType = primaryEntity.type;
  const isRootEntity = !primaryEntity.parent_id;

  // Fetch connections if requested (default: true)
  let connections: ConnectionInfo[] | undefined;
  if (args.include_connections ?? true) {
    connections = await fetchConnectionsForEntity(primaryEntity.id);
  }

  // Fetch children for root entities (no parent)
  let children: UnifiedSearchResult['children'];
  if (isRootEntity) {
    const childRows = await getDb()<ChildEntityRow>`
      SELECT
        e.id,
        e.name,
        e.entity_type,
        e.metadata::jsonb->>'market' as market,
        COALESCE(
          (SELECT COUNT(*) FROM current_event_records WHERE e.id = ANY(entity_ids)),
          0
        ) as content_count
      FROM entities e
      WHERE e.parent_id = ${primaryEntity.id}
      ORDER BY e.created_at DESC
    `;
    children = childRows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      type: row.entity_type,
      market: row.market,
      content_count: Number(row.content_count),
    }));
  }

  // Generate helpful suggestion based on connection status
  let suggestion: string;
  if (matches.length === 1) {
    const activeConnections =
      connections?.filter((c) => c.status === 'active').length ||
      primaryEntity.stats.active_connection_count;
    const pausedConnections = connections?.filter((c) => c.status === 'paused').length || 0;

    if (activeConnections === 0 && pausedConnections === 0) {
      suggestion = `Entity "${primaryEntity.name}" found with no connections. Use manage_connections to add one and start collection.`;
    } else if (activeConnections === 0 && pausedConnections > 0) {
      suggestion = `Entity "${primaryEntity.name}" has ${pausedConnections} paused connection(s). Reactivate a connection to resume collection.`;
    } else {
      suggestion = `Entity "${primaryEntity.name}" found with ${activeConnections} active connection(s).`;
    }
  } else {
    suggestion = `Found ${matches.length} matching entities.`;
  }

  // Build view URL for the primary entity
  let viewUrl: string | undefined;
  if (primaryEntity.organization_slug) {
    viewUrl = buildEntityUrl(
      {
        ownerSlug: primaryEntity.organization_slug,
        entityType: entityType,
        slug: primaryEntity.slug,
        parentType: primaryEntity.parent_entity_type ?? null,
        parentSlug: primaryEntity.parent_slug ?? null,
      },
      baseUrl
    );
  }

  return {
    entity_type: entityType,
    entity: primaryEntity,
    matches,
    connections,
    children,
    discovery_status: 'complete',
    suggestion,
    view_url: viewUrl,
    metadata: {
      total_matches: matches.length,
      page_size: matches.length,
    },
  };
}

async function fetchConnectionsForEntity(entityId: number): Promise<ConnectionInfo[]> {
  const sql = getDb();
  const result = await sql`
    SELECT
      c.id as connection_id,
      c.connector_key,
      c.display_name,
      c.status,
      c.config,
      (
        SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
        FROM feeds f2
        JOIN entities ent ON ent.id = ANY(f2.entity_ids)
        WHERE f2.connection_id = c.id AND f2.deleted_at IS NULL
      ) as entity_names,
      c.created_at,
      c.updated_at,
      COALESCE(COUNT(f.id), 0) as content_count
    FROM connections c
    LEFT JOIN current_event_records f ON f.connection_id = c.id
    WHERE EXISTS (
      SELECT 1
      FROM feeds scoped_feed
      WHERE scoped_feed.connection_id = c.id
        AND scoped_feed.deleted_at IS NULL
        AND ${entityId} = ANY(scoped_feed.entity_ids)
    )
    GROUP BY c.id, c.connector_key, c.display_name, c.status, c.config, c.created_at, c.updated_at
    ORDER BY
      CASE c.status
        WHEN 'active' THEN 1
        WHEN 'paused' THEN 2
        ELSE 4
      END,
      c.created_at DESC
    LIMIT 20
  `;

  return result as ConnectionInfo[];
}

async function attachOrganizationSlugs(rows: EntityQueryRow[]): Promise<void> {
  if (rows.length === 0) return;

  const orgIds = Array.from(new Set(rows.map((row) => row.organization_id))).filter(Boolean);
  if (orgIds.length === 0) return;

  const slugById = await getWorkspaceProvider().getOrgSlugs(orgIds);

  for (const row of rows) {
    row.organization_slug = slugById.get(row.organization_id) ?? null;
  }
}
