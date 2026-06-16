/**
 * Tool: read_knowledge — SQL query building and the direct list branches
 * (content_ids lookup, include_superseded history listing, classification
 * stats aggregation).
 */

import { type DbClient, pgTextArray } from '../../db/client';
import {
  buildConnectionVisibilityClause,
  buildEntityLinkUnion,
  fetchEntityIdentityScopes,
} from '../../utils/content-search';
import logger from '../../utils/logger';
import { validateNumericId } from '../../utils/sql-validation';
import type { GetContentArgs } from './schema';
import type { ClassificationStatsRow, ContentRow, GetContentResult } from './types';

/** Connection-visibility scope derived from the tool context. */
interface VisibilityScope {
  organizationId: string;
  userId: string | null;
}

/** Shared shape returned by the direct list branches. */
interface ListPageResult {
  rawContent: ContentRow[];
  total: number;
  pageInfo: GetContentResult['page'];
}

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

/**
 * Direct query by content IDs — simple and fast. Bypasses other filters
 * except entity_id. Caller dispatches here only when content_ids is non-empty.
 */
export async function fetchByContentIds(opts: {
  args: GetContentArgs;
  sql: DbClient;
  organizationId: string;
  visibilityScope: VisibilityScope;
  limit: number;
  offset: number;
}): Promise<ListPageResult> {
  const { args, sql, organizationId, visibilityScope, limit, offset } = opts;

  // typebox validates content_ids as number[] at the tool boundary; the
  // caller only dispatches here when it is non-empty.
  const contentIdsArray = args.content_ids ?? [];

  logger.info(`[get_content] Filtering by ${contentIdsArray.length} specific content IDs`);

  // Build parameterized IN clause for content IDs
  const idPlaceholders = contentIdsArray.map((_, i) => `$${i + 1}`).join(',');
  const queryParams: Array<string | number | null> = [...contentIdsArray];

  queryParams.push(organizationId);
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

  const rawContent = result as unknown as ContentRow[];
  const total = Number(countResult[0]?.total ?? 0);
  return {
    rawContent,
    total,
    pageInfo: {
      limit,
      offset,
      has_more: offset + rawContent.length < total,
    },
  };
}

/**
 * Entity-scoped chronological listing over `events` including superseded
 * historical rows. Caller validates args via
 * `getIncludeSupersededValidationErrors` before dispatching here.
 */
export async function fetchIncludeSuperseded(opts: {
  args: GetContentArgs;
  sql: DbClient;
  organizationId: string;
  entityId: number | undefined;
  effectiveConnectionIds: number[] | undefined;
  effectivePlatform: string | undefined;
  sinceDate: Date | null;
  untilDate: Date | null;
  visibilityScope: VisibilityScope;
  limit: number;
  offset: number;
}): Promise<ListPageResult> {
  const {
    args,
    sql,
    organizationId,
    entityId,
    effectiveConnectionIds,
    effectivePlatform,
    sinceDate,
    untilDate,
    visibilityScope,
    limit,
    offset,
  } = opts;

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
    organizationId,
    ...supersededLink.params,
  ];
  let paramIndex = 2 + supersededLink.params.length;

  if (effectiveConnectionIds && effectiveConnectionIds.length > 0) {
    const placeholders = effectiveConnectionIds.map(() => `$${paramIndex++}`).join(',');
    conditions.push(`e.connection_id IN (${placeholders})`);
    queryParams.push(...effectiveConnectionIds);
  }
  if (args.feed_ids && args.feed_ids.length > 0) {
    const validFeedIds = args.feed_ids.filter((id) => Number.isInteger(id));
    if (validFeedIds.length > 0) {
      const placeholders = validFeedIds.map(() => `$${paramIndex++}`).join(',');
      conditions.push(`e.feed_id IN (${placeholders})`);
      queryParams.push(...validFeedIds);
    }
  }
  if (args.run_ids && args.run_ids.length > 0) {
    const validRunIds = args.run_ids.filter((id) => Number.isInteger(id));
    if (validRunIds.length > 0) {
      const placeholders = validRunIds.map(() => `$${paramIndex++}`).join(',');
      conditions.push(`e.run_id IN (${placeholders})`);
      queryParams.push(...validRunIds);
    }
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
    const types = Array.isArray(args.semantic_type)
      ? args.semantic_type
      : [args.semantic_type];
    conditions.push(`e.semantic_type = ANY($${paramIndex}::text[])`);
    queryParams.push(pgTextArray(types));
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

  const rawContent = result as unknown as ContentRow[];
  const total = Number(countResult[0]?.total ?? 0);
  return {
    rawContent,
    total,
    pageInfo: {
      limit,
      offset,
      has_more: offset + rawContent.length < total,
    },
  };
}

/**
 * Classification statistics aggregated across ALL matching content (not just
 * paginated results).
 * NOTE: Stats are computed WITHOUT classification filters to show the full
 * distribution (sticky stats). This allows users to see all available values
 * even when filtering, enabling informed filter choices.
 */
export async function fetchClassificationStats(opts: {
  args: GetContentArgs;
  sql: DbClient;
  effectiveConnectionIds: number[] | undefined;
  effectivePlatform: string | undefined;
  sinceDate: Date | null;
  untilDate: Date | null;
  visibilityScope: VisibilityScope;
}): Promise<NonNullable<GetContentResult['classification_stats']>> {
  const {
    args,
    sql,
    effectiveConnectionIds,
    effectivePlatform,
    sinceDate,
    untilDate,
    visibilityScope,
  } = opts;

  // Build dynamic WHERE conditions using inline SQL
  const conditions: string[] = ['1=1'];
  const params: Array<string | number | null> = [];
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
  const classificationStats: NonNullable<GetContentResult['classification_stats']> = {};
  for (const row of statsQueryResult as unknown as ClassificationStatsRow[]) {
    (classificationStats[row.classifier_slug] ??= {})[row.value] = Number(row.count);
  }
  return classificationStats;
}
