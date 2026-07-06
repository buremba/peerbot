/**
 * Content listing path: executeListQuery and listContentInternal.
 */

import { type DbClient, pgTextArray } from '../../db/client';
import {
  buildConnectionFilter,
  buildFeedFilter,
  buildOrderByClause,
  buildRunFilter,
  groupClassificationFilters,
} from '../content-query-filters';
import { parseDateAlias, toEndOfDay } from '../date-aliases';
import { validateNumericId } from '../sql-validation';
import {
  buildClassificationExistsClauses,
  resolveClassifierIds,
} from './classification';
import { buildLatestClassificationsCteSql, buildThreadMetaCteSql } from './ctes';
import { buildEntityLinkUnion, entityLinkMatchSql, fetchEntityIdentityScopes } from './entity-link';
import type { EntityIdentityScope } from './entity-link';
import { buildFinalSelect, deduplicateWithClassifications } from './sql-fragments';
import {
  buildDateCandidateOrderBy,
  buildDateCursorClause,
  buildPageInfo,
  emptyListResponse,
  isDateFeedMode,
  resolveDateCursor,
  type ContentSearchOptions,
  type ContentSearchResponse,
  type ContentSearchResult,
} from './types';
import { buildEntityTypesFilterClause } from './entity-types-filter';
import { buildConnectionVisibilityClause, buildExcludeWatcherClause, buildOrgScopeWhere } from './visibility';
import { buildStandardParams, buildStandardWhereSql, WINDOW_JOIN_SQL } from './params';

/**
 * Shared count + query-pair execution for both `listContentInternal` branches.
 *
 * The two branches differ only in how they assemble `whereExpr` (the full
 * WHERE body, excluding the date cursor clause) and whether they need the
 * `watcher_window_events` join (`joinSql`). Everything past the count — the
 * empty-result short-circuit, the `candidate_set/result_set` vs `result_set`
 * CTE pair, param indexing, dedup, and the response shape — is identical, so
 * it lives here. The generated SQL and parameter binding are unchanged.
 */
async function executeListQuery(args: {
  sql: DbClient;
  joinSql: string;
  whereExpr: string;
  countParams: any[];
  threadEntityLinkSqlForP: string | undefined;
  needClassifications: boolean;
  useDateFeed: boolean;
  cursor: ReturnType<typeof resolveDateCursor>;
  orderByForResultSet: string;
  latestClassificationsCteSql: string;
  mkFinalSelect: (withClassifications: boolean) => string;
  limit: number;
  effectiveOffset: number;
  fetchLimit: number;
}): Promise<ContentSearchResponse> {
  const { sql, joinSql, whereExpr, countParams } = args;

  const countResult = await sql.unsafe<{ total: number | string }>(
    `SELECT COUNT(*) as total FROM current_event_records f
      LEFT JOIN connections c ON c.id = f.connection_id
      ${joinSql}
      WHERE ${whereExpr}`,
    countParams
  );
  const total = parseInt(String(countResult[0]?.total ?? '0'), 10);

  // Short-circuit on empty matches. Even with the trimmed entity-link UNION,
  // the enrichment query — recursive thread_meta + classifications +
  // parent/root LEFT JOINs — pays a real planner cost on a large events table
  // when run via postgres.js's extended protocol even if result_set is empty
  // server-side. One extra round-trip on the cheap count beats that.
  if (total === 0) {
    return emptyListResponse({
      limit: args.limit,
      effectiveOffset: args.effectiveOffset,
      useDateFeed: args.useDateFeed,
      cursor: args.cursor,
    });
  }

  const cursorClause = buildDateCursorClause(
    args.cursor,
    'f.occurred_at',
    'f.id',
    countParams.length + 1
  );
  const queryBaseParams = [...countParams, ...cursorClause.params];
  const limitIdx = queryBaseParams.length + 1;
  const offsetIdx = queryBaseParams.length + 2;
  const validatedLimit = validateNumericId(args.limit, 'limit');
  const threadMetaCteSql = buildThreadMetaCteSql('$1', 'result_set', args.threadEntityLinkSqlForP);
  const ctes = args.needClassifications
    ? `${threadMetaCteSql},\n      ${args.latestClassificationsCteSql}`
    : threadMetaCteSql;

  const querySQL = args.useDateFeed
    ? `
      WITH RECURSIVE candidate_set AS (
        SELECT
          f.id,
          f.occurred_at
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${joinSql}
        WHERE ${whereExpr}
          ${cursorClause.sql}
        ORDER BY ${buildDateCandidateOrderBy(args.cursor, 'f')}
        LIMIT $${limitIdx}
      ),
      result_set AS (
        SELECT
          cs.id,
          (SELECT COUNT(*) FROM candidate_set) as cursor_fetched_count
        FROM candidate_set cs
        ORDER BY ${buildDateCandidateOrderBy(args.cursor, 'cs')}
        LIMIT ${validatedLimit}
      ),
      ${ctes}
      ${args.mkFinalSelect(args.needClassifications)}`
    : `
      WITH RECURSIVE result_set AS (
        SELECT
          f.id,
          NULL::bigint as cursor_fetched_count
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${joinSql}
        WHERE ${whereExpr}
        ORDER BY ${args.orderByForResultSet}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      ),
      ${ctes}
      ${args.mkFinalSelect(args.needClassifications)}`;

  const queryParams = args.useDateFeed
    ? [...queryBaseParams, args.fetchLimit]
    : [...queryBaseParams, args.limit, args.effectiveOffset];

  const rawRows = (await args.sql.unsafe(querySQL, queryParams)) as any[];

  const content = args.needClassifications
    ? deduplicateWithClassifications(rawRows)
    : (rawRows as any as ContentSearchResult[]);

  return {
    content,
    total,
    page: buildPageInfo({
      limit: args.limit,
      offset: args.effectiveOffset,
      total,
      returnedCount: content.length,
      useDateFeed: args.useDateFeed,
      cursor: args.cursor,
      fetchedCount: rawRows[0]?.cursor_fetched_count,
    }),
  };
}

export async function listContentInternal(
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
  const feedIdsArray =
    options.feed_ids && options.feed_ids.length > 0 ? options.feed_ids : null;
  const runIdsArray =
    options.run_ids && options.run_ids.length > 0 ? options.run_ids : null;

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

  const needClassifications = !!(
    options.include_classifications ||
    (options.classification_filters && options.classification_filters.length > 0)
  );

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
    const classifierIds = await resolveClassifierIds(sql, filtersBySlug, entityId);
    const connectionFilterClause = buildConnectionFilter(connectionIdsArray);
    const feedFilterClause = buildFeedFilter(feedIdsArray);
    const runFilterClause = buildRunFilter(runIdsArray);

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
    baseConditions.push(feedFilterClause);
    baseConditions.push(runFilterClause);

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
    if (options.analyzed_by_watcher_id != null) {
      baseParams.push(options.analyzed_by_watcher_id);
      baseConditions.push(
        `EXISTS (SELECT 1 FROM watcher_window_events iwf WHERE iwf.event_id = f.id AND iwf.watcher_id = $${baseParams.length})`
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
      // Match any of the requested types — single-string callers get wrapped
      // into a one-element Postgres array literal so the same predicate fits.
      const types = Array.isArray(options.semantic_type)
        ? options.semantic_type
        : [options.semantic_type];
      baseParams.push(pgTextArray(types));
      baseConditions.push(`f.semantic_type = ANY($${baseParams.length}::text[])`);
    }
    if (options.interaction_status) {
      baseParams.push(options.interaction_status);
      baseConditions.push(`f.interaction_status = $${baseParams.length}`);
    }
    if (options.agent_id) {
      baseParams.push(options.agent_id);
      baseConditions.push(`f.metadata->>'agent_id' = $${baseParams.length}`);
    }

    const classificationExists = buildClassificationExistsClauses(
      filtersBySlug,
      classifierIds,
      options.classification_source,
      baseParams.length + 1
    );
    if (!classificationExists) {
      return emptyListResponse({ limit, effectiveOffset, useDateFeed, cursor });
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
    const filterParamsBeforeEntityTypes = [
      ...filterParamsBeforeVisibility,
      ...visibilityClause.params,
    ];
    const entityTypesClause = buildEntityTypesFilterClause({
      entity_types: options.entity_types,
      organization_id: organizationId,
      baseParamIndex: filterParamsBeforeEntityTypes.length + 1,
    });
    const allFilterParams = [...filterParamsBeforeEntityTypes, ...entityTypesClause.params];

    return executeListQuery({
      sql,
      joinSql: '',
      whereExpr: `${whereSql} ${excludeClause.sql} ${visibilityClause.sql}${entityTypesClause.sql}`,
      countParams: allFilterParams,
      threadEntityLinkSqlForP: threadEntityLinkSql,
      needClassifications,
      useDateFeed,
      cursor,
      orderByForResultSet,
      latestClassificationsCteSql,
      mkFinalSelect,
      limit,
      effectiveOffset,
      fetchLimit,
    });
  }

  const connectionCondition = buildConnectionFilter(connectionIdsArray);
  const feedCondition = buildFeedFilter(feedIdsArray);
  const runCondition = buildRunFilter(runIdsArray);
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
  const paramsBeforeEntityTypes = [...paramsBeforeVisibility, ...visibilityClause.params];
  const entityTypesClause = buildEntityTypesFilterClause({
    entity_types: options.entity_types,
    organization_id: organizationId,
    baseParamIndex: paramsBeforeEntityTypes.length + 1,
  });
  const countParams = [...paramsBeforeEntityTypes, ...entityTypesClause.params];

  return executeListQuery({
    sql,
    joinSql: WINDOW_JOIN_SQL,
    whereExpr: `${standardWhereSql}
          AND ${connectionCondition}
          AND ${feedCondition}
          AND ${runCondition}
          ${excludeClause.sql}
          ${visibilityClause.sql}
          ${orgScope.sql}${entityTypesClause.sql}`,
    countParams,
    threadEntityLinkSqlForP: standardEntityLinkSqlForP,
    needClassifications,
    useDateFeed,
    cursor,
    orderByForResultSet,
    latestClassificationsCteSql,
    mkFinalSelect,
    limit,
    effectiveOffset,
    fetchLimit,
  });
}
