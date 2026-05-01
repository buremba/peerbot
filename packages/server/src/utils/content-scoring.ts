import { getDb } from '../db/client';
import { buildClassificationFilterSQL } from './content-query-filters';
import {
  buildConnectionVisibilityClause,
  buildEntityLinkUnion,
  type EntityIdentityScope,
  entityLinkMatchSql,
  fetchEntityIdentityScopes,
} from './content-search';
import logger from './logger';
import { getScoringFormulaSql, resolveStoredScoringProfile } from './scoring-profiles';
import { validateAndFormatIds, validateNumericId } from './sql-validation';

interface NormalizedScoreFilters {
  connection_ids?: number[];
  platform?: string;
  since?: Date;
  until?: Date;
  engagement_min?: number;
  engagement_max?: number;
  // Additional filters to match searchContentByText
  window_id?: number;
  exclude_watcher_id?: number; // Exclude content already in any window for this watcher
  classification_filters?: Array<{ classifier_slug: string; value: string }>;
  classification_source?: 'user' | 'embedding' | 'llm';
  semantic_type?: string;
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
  /**
   * Connection-visibility scope. Folds into the WHERE so events from
   * private connections the caller can't see don't appear in score-sorted
   * results. Mirrors the clause used by `listContentInternal` and the
   * `content_ids` / `include_superseded` branches in `get_content.ts`.
   */
  visibility_scope?: { organizationId: string; userId: string | null };
}

/**
 * Content result type from getNormalizedScoreContent.
 * IMPORTANT: This must include `classifications` to match ContentsTab expectations.
 * The frontend relies on classifications being present for all sort modes (date AND score).
 */
interface NormalizedScoreContent {
  id: number;
  entity_ids: number[] | string;
  connection_id: number;
  origin_id: string;
  title: string | null;
  payload_text: string;
  author_name: string | null;
  source_url: string | null;
  occurred_at: string;
  semantic_type: string;
  raw_score: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  origin_parent_id: string | null;
  content_length: number;
  platform: string;
  interaction_type?: 'none' | 'approval' | null;
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;
  root_origin_id: string;
  depth: number;
  score: number;
  score_breakdown: {
    raw_score: number | null;
    content_length: number;
    calculated_score: number;
  };
  /**
   * Classifications keyed by attribute_key.
   * REQUIRED: Without this, the frontend won't display classifications when sorting by score.
   */
  classifications: Record<
    string,
    {
      values: string[];
      source: string;
      confidences: Record<string, number>;
      is_manual: boolean;
      used_fallback_value?: boolean;
    }
  >;
}

function buildFilterConditionsAndJoins(
  entityId: number,
  filters?: NormalizedScoreFilters,
  baseParamIndex: number = 1,
  entityScopes?: EntityIdentityScope[]
): { filterConditions: string[]; additionalJoins: string[]; params: unknown[] } {
  let paramIndex = baseParamIndex;
  const params: unknown[] = [];
  // Use the trimmed UNION when scopes were pre-fetched. Falls back to the
  // legacy 7-branch UNION (kept for the few callers that don't pre-fetch).
  let entityLinkSql: string;
  if (entityScopes !== undefined) {
    const link = buildEntityLinkUnion({
      entityIdLiteral: entityId,
      scopes: entityScopes,
      alias: 'f',
      baseParamIndex: paramIndex,
    });
    entityLinkSql = link.sql;
    params.push(...link.params);
    paramIndex += link.params.length;
  } else {
    entityLinkSql = entityLinkMatchSql(`${entityId}::bigint`);
  }
  const filterConditions: string[] = [entityLinkSql];
  const additionalJoins: string[] = [];

  if (filters?.connection_ids && filters.connection_ids.length > 0) {
    const validatedIds = validateAndFormatIds(filters.connection_ids, 'connection_ids');
    filterConditions.push(`f.connection_id IN (${validatedIds})`);
  }

  if (filters?.platform) {
    params.push(filters.platform);
    filterConditions.push(`s.connector_key = $${paramIndex++}`);
  }

  if (filters?.since) {
    const sinceDate = typeof filters.since === 'string' ? new Date(filters.since) : filters.since;
    params.push(sinceDate.toISOString());
    filterConditions.push(`f.occurred_at >= $${paramIndex++}::timestamptz`);
  }
  if (filters?.until) {
    const untilDate = typeof filters.until === 'string' ? new Date(filters.until) : filters.until;
    params.push(untilDate.toISOString());
    filterConditions.push(`f.occurred_at <= $${paramIndex++}::timestamptz`);
  }

  if (filters?.engagement_min !== undefined && filters.engagement_min !== null) {
    params.push(filters.engagement_min);
    filterConditions.push(`f.score >= $${paramIndex++}::numeric`);
  }
  if (filters?.engagement_max !== undefined && filters.engagement_max !== null) {
    params.push(filters.engagement_max);
    filterConditions.push(`f.score <= $${paramIndex++}::numeric`);
  }

  if (filters?.window_id !== undefined) {
    const validatedWindowId = validateNumericId(filters.window_id, 'window_id');
    additionalJoins.push('JOIN watcher_window_events iwc ON iwc.event_id = f.id');
    params.push(validatedWindowId);
    filterConditions.push(`iwc.window_id = $${paramIndex++}`);
  }

  if (filters?.exclude_watcher_id !== undefined) {
    const validatedWatcherId = validateNumericId(filters.exclude_watcher_id, 'exclude_watcher_id');
    params.push(validatedWatcherId);
    filterConditions.push(`NOT EXISTS (
      SELECT 1 FROM watcher_window_events exc_iwc
      JOIN watcher_windows exc_iw ON exc_iw.id = exc_iwc.window_id
      WHERE exc_iwc.event_id = f.id AND exc_iw.watcher_id = $${paramIndex++}
    )`);
  }

  if (filters?.semantic_type) {
    params.push(filters.semantic_type);
    filterConditions.push(`f.semantic_type = $${paramIndex++}`);
  }

  if (filters?.interaction_status) {
    params.push(filters.interaction_status);
    filterConditions.push(`f.interaction_status = $${paramIndex++}`);
  }

  if (filters?.classification_filters || filters?.classification_source) {
    const { conditions: classificationConditions, params: classificationParams } =
      buildClassificationFilterSQL(
        filters.classification_filters || [],
        filters.classification_source,
        'f',
        paramIndex
      );
    filterConditions.push(...classificationConditions);
    params.push(...classificationParams);
    paramIndex += classificationParams.length;
  }

  if (filters?.visibility_scope) {
    const visibility = buildConnectionVisibilityClause(
      {
        organizationId: filters.visibility_scope.organizationId,
        userId: filters.visibility_scope.userId,
        baseParamIndex: paramIndex,
      },
      'f'
    );
    if (visibility.sql) {
      // Drop the leading "AND " — `filterConditions` is joined with ' AND '
      // by callers, so the bare predicate is what we want.
      filterConditions.push(visibility.sql.replace(/^AND\s+/, ''));
      params.push(...visibility.params);
      paramIndex += visibility.params.length;
    }
  }

  return { filterConditions, additionalJoins, params };
}
export async function getNormalizedScoreContent(
  entityId: number,
  limit: number = 50,
  offset: number = 0,
  filters?: NormalizedScoreFilters
): Promise<NormalizedScoreContent[]> {
  const sql = getDb();

  // Step 1: Get all sources for this entity with their formulas
  // Validate entityId to prevent injection
  validateNumericId(entityId, 'entityId');

  // Pre-fetch identity scopes once, share across both step 1 (sources) and
  // step 3 (scored content). Trims unused UNION branches from each.
  const entityScopes = await fetchEntityIdentityScopes(sql, entityId);
  const sourcesEntityLink = buildEntityLinkUnion({
    entityIdLiteral: entityId,
    scopes: entityScopes,
    alias: 'f',
    baseParamIndex: 1,
  });

  const conditions: string[] = [sourcesEntityLink.sql];
  const params: unknown[] = [...sourcesEntityLink.params];
  let paramIndex = 1 + sourcesEntityLink.params.length;

  if (filters?.connection_ids && filters.connection_ids.length > 0) {
    // Validate all connection_ids are valid integers before using in SQL
    const validatedIds = validateAndFormatIds(filters.connection_ids, 'connection_ids');
    conditions.push(`s.id IN (${validatedIds})`);
  }
  if (filters?.platform) {
    conditions.push(`s.connector_key = $${paramIndex++}`);
    params.push(filters.platform);
  }

  // Visibility: keep the discovery scan's connection set in lockstep with the
  // final scored query. Today the leak isn't directly observable (the final
  // query is visibility-filtered, so a hidden source produces a CASE WHEN
  // branch that never fires), but counts/aggregates on this CTE could leak
  // existence info, and a future refactor that promotes its rows into the
  // returned set would turn this into a real leak. Same helper as the rest
  // of get_content's branches use.
  if (filters?.visibility_scope) {
    const preVisibility = buildConnectionVisibilityClause(
      {
        organizationId: filters.visibility_scope.organizationId,
        userId: filters.visibility_scope.userId,
        baseParamIndex: paramIndex,
      },
      'f'
    );
    if (preVisibility.sql) {
      conditions.push(preVisibility.sql.replace(/^AND\s+/, ''));
      params.push(...preVisibility.params);
      paramIndex += preVisibility.params.length;
    }
  }

  const sources = await sql.unsafe(
    `
    SELECT DISTINCT
      s.id,
      s.connector_key as type,
      NULL::text as scoring_formula
    FROM current_event_records f
    LEFT JOIN connections s ON f.connection_id = s.id
    WHERE ${conditions.join(' AND ')}
  `,
    params
  );

  if (sources.length === 0) {
    return [];
  }

  // Step 2: Build CASE WHEN expression for scoring
  // Each source can have its own fixed scoring profile.
  const caseWhenParts: string[] = [];
  for (const source of sources) {
    // Validate source.id is a valid integer (defense in depth)
    const sourceId = validateNumericId(Number(source.id), 'source.id');
    const scoringProfile = resolveStoredScoringProfile(
      source.scoring_formula as string | null | undefined,
      source.type as string | null | undefined
    );
    const formula = getScoringFormulaSql(scoringProfile);
    // Wrap formula to ensure it returns 0-100
    caseWhenParts.push(
      `WHEN f.connection_id = ${sourceId} THEN LEAST(100, GREATEST(0, ${formula.trim()}))`
    );
  }

  // Default case (shouldn't happen, but safety)
  caseWhenParts.push('ELSE 50');

  const scoringExpression = `CASE ${caseWhenParts.join(' ')} END`;

  // Step 3: Build and execute the dynamic query. Pass the pre-fetched
  // identity scopes through so the trimmed entity-link UNION is used.
  const {
    filterConditions,
    additionalJoins,
    params: filterParams,
  } = buildFilterConditionsAndJoins(entityId, filters, 1, entityScopes);
  const whereClause = filterConditions.join(' AND ');
  const joinClause = additionalJoins.join(' ');

  const query = `
    WITH scored_content AS (
      SELECT
        f.id,
        f.entity_ids,
        f.connection_id,
        f.origin_id,
        f.title,
        f.payload_text,
        f.author_name,
        f.source_url,
        f.occurred_at,
        f.semantic_type,
        f.score as raw_score,
        f.metadata,
        f.created_at,
        f.origin_parent_id,
        f.content_length,
        s.connector_key as platform,
        f.interaction_type,
        f.interaction_status,
        f.interaction_input_schema,
        f.interaction_input,
        f.interaction_output,
        f.interaction_error,
        f.supersedes_event_id,
        -- Dynamic scoring formula
        ${scoringExpression} as calculated_score,
        -- Thread metadata
        COALESCE(f.origin_parent_id, f.origin_id) as root_origin_id,
        CASE WHEN f.origin_parent_id IS NULL THEN 0 ELSE 1 END as depth
      FROM current_event_records f
      LEFT JOIN connections s ON f.connection_id = s.id
      ${joinClause}
      WHERE ${whereClause}
    )
    SELECT
      sc.id,
      sc.entity_ids,
      sc.connection_id,
      sc.origin_id,
      sc.title,
      sc.payload_text,
      sc.author_name,
      sc.source_url,
      sc.occurred_at,
      sc.semantic_type,
      sc.raw_score,
      sc.metadata,
      sc.created_at,
      sc.origin_parent_id,
      sc.content_length,
      sc.platform,
      sc.interaction_type,
      sc.interaction_status,
      sc.interaction_input_schema,
      sc.interaction_input,
      sc.interaction_output,
      sc.interaction_error,
      sc.supersedes_event_id,
      sc.root_origin_id,
      sc.depth,
      ROUND(CAST(sc.calculated_score AS DECIMAL), 2) as score,
      -- Include formula for debugging
      jsonb_build_object(
        'raw_score', sc.raw_score,
        'content_length', sc.content_length,
        'calculated_score', ROUND(CAST(sc.calculated_score AS DECIMAL), 2)
      ) as score_breakdown,
      -- Aggregate classifications keyed by attribute_key
      COALESCE(
        cls.classifications,
        '{}'::jsonb
      ) as classifications
    FROM scored_content sc
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
    ) cls ON cls.event_id = sc.id
    ORDER BY sc.calculated_score DESC, sc.occurred_at DESC, sc.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  logger.debug({ query: query.substring(0, 500) }, 'Executing normalized score query');

  try {
    const result = await sql.unsafe(query, filterParams);
    return result as NormalizedScoreContent[];
  } catch (error) {
    logger.error({ error, query: query.substring(0, 1000) }, 'Normalized score query failed');
    throw error;
  }
}

/**
 * Get total count for normalized score content (same filters, no pagination)
 */
export async function getNormalizedScoreContentCount(
  entityId: number,
  filters?: NormalizedScoreFilters
): Promise<number> {
  const sql = getDb();

  validateNumericId(entityId, 'entityId');

  // Pre-fetch scopes here too so the count query also uses the trimmed UNION.
  // Cheap (~1ms) and runs in parallel with the main scored query in
  // get_content.ts via Promise.all.
  const entityScopes = await fetchEntityIdentityScopes(sql, entityId);

  const {
    filterConditions,
    additionalJoins,
    params: filterParams,
  } = buildFilterConditionsAndJoins(entityId, filters, 1, entityScopes);
  const whereClause = filterConditions.join(' AND ');
  const joinClause = additionalJoins.join(' ');

  const countQuery = `
    SELECT COUNT(DISTINCT f.id) as total
    FROM current_event_records f
    LEFT JOIN connections s ON f.connection_id = s.id
    ${joinClause}
    WHERE ${whereClause}
  `;

  try {
    const result = await sql.unsafe(countQuery, filterParams);
    return Number(result[0]?.total || 0);
  } catch (error) {
    logger.error({ error }, 'Normalized score count query failed');
    throw error;
  }
}
