/**
 * Tool: read_knowledge — SQL query building and the direct list branches
 * (content_ids lookup, include_superseded history listing, classification
 * stats aggregation).
 */

import { type DbClient, pgBigintArray, pgTextArray } from '../../db/client';
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
  /** Extra JOIN clause(s) spliced in before the fixed connection/oauth joins. */
  join?: string;
  where: string;
  orderBy: string;
  limit: number;
  offset: number;
}): string {
  const { table, alias: a, join = '', where, orderBy, limit, offset } = opts;
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
      ${a}.run_id,
      oc.client_name,
      -- classifications was sourced from latest_event_classifications, a denormalized cache that was
      -- never populated (no writer) — so this field has always been '{}'. Kept empty for response-shape
      -- stability now that the dead table is dropped.
      '{}'::jsonb as classifications
    FROM ${table} ${a}
    ${join}
    LEFT JOIN connections c ON c.id = ${a}.connection_id
    LEFT JOIN oauth_clients oc ON oc.id = ${a}.client_id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit}
    OFFSET ${offset}
  `;
}

/**
 * Chain-resolution CTE. Expands each requested content id to its full supersede
 * lineage so a permalink minted at pending-approval time (its id is later
 * superseded and hidden from `current_event_records`) still resolves — and
 * shows the whole pending→executing→completed history, not just the head.
 *
 * Reads from `events` (not the masked view) because superseded rows are the
 * whole point. Two arms, UNIONed:
 *  - run arm: operation/approval chains all share one `run_id`, so a single
 *    indexed lookup returns pending + executing + completed together.
 *  - walk arm: seeds with `run_id IS NULL` (e.g. an edited note) have no run to
 *    key on, so we walk the `superseded_by` / `supersedes_event_id` linked list
 *    out from the seed in both directions. Bounded (chains are 2–3 hops; the
 *    forward edge is uniquely indexed), so the recursion terminates cheaply.
 *
 * `$1` must be a bigint[] bind param of the requested ids. Emits a CTE named
 * `resolved_ids(id, chain_key)` — `id` is an event id in a resolved chain and
 * `chain_key` is a stable per-chain identifier shared by every row of the same
 * lineage, so the caller can `COUNT(DISTINCT chain_key)` to count chains (an
 * atomic unit) rather than expanded rows. The caller filters the final read to
 * `f.id IN (SELECT id FROM resolved_ids)`.
 */
const RESOLVED_IDS_CTE = `
  resolved_ids AS (
    -- run arm: every row of the seed's run (the common approval/operation case).
    -- Chain key is the run id, text-prefixed so it can't collide with the walk
    -- arm's event-id keys.
    SELECT run_ev.id, 'run:' || seed.run_id AS chain_key
    FROM events seed
    JOIN events run_ev ON run_ev.run_id = seed.run_id
    WHERE seed.id = ANY($1::bigint[]) AND seed.run_id IS NOT NULL
    UNION
    -- walk arm: run_id-less chains, transitive closure both directions. Chain
    -- key is the lineage root (oldest ancestor), which every row in the chain
    -- shares regardless of which id the caller entered from.
    SELECT walked.id, 'ev:' || walked.root AS chain_key
    FROM (
      WITH RECURSIVE lineage(id, root) AS (
        -- Seed each run_id-less requested id with its own oldest ancestor as
        -- the provisional root; MIN() over the component finalizes it below.
        SELECT s.id, s.id AS root
        FROM events s
        WHERE s.id = ANY($1::bigint[]) AND s.run_id IS NULL
        UNION
        SELECT nxt.id, LEAST(l.root, nxt.id)
        FROM lineage l
        JOIN events cur ON cur.id = l.id
        JOIN events nxt
          ON nxt.id = cur.superseded_by        -- forward: newer
          OR nxt.id = cur.supersedes_event_id  -- backward: older
      )
      -- A component can be reached from multiple seeds / hop orders; collapse to
      -- one row per event with the smallest root so the chain key is stable.
      SELECT id, MIN(root) AS root FROM lineage GROUP BY id
    ) walked
  )
`;

/**
 * Direct query by content IDs. Each requested id is expanded to its full
 * supersede chain (see {@link RESOLVED_IDS_CTE}) so stale permalinks resolve and
 * the caller sees the pending→completed history. Bypasses other filters except
 * entity_id. Caller dispatches here only when content_ids is non-empty.
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

  // $1 is the requested-id array, consumed by RESOLVED_IDS_CTE. All later
  // filters bind from $2 onward and read the expanded chain set, so org scope,
  // entity link, and visibility apply to every resolved row, not just the seed.
  const queryParams: Array<string | number | null> = [pgBigintArray(contentIdsArray)];
  const idFilter = 'f.id IN (SELECT id FROM resolved_ids)';

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

  const where = `${idFilter} ${orgScope}${entityFilter} ${visibility.sql}`;

  // Read the full chain from `events` (not the masked view — superseded rows are
  // what we're here for). The list query JOINs resolved_ids so it can order by
  // the resolver's stable `chain_key`: lineages never interleave, and within a
  // chain rows read pending→completed top-to-bottom by occurred_at.
  const result = await sql.unsafe(
    `
    WITH ${RESOLVED_IDS_CTE}
    ${buildContentQuery({
      table: 'events',
      alias: 'f',
      join: 'JOIN resolved_ids ri ON ri.id = f.id',
      where,
      orderBy: 'ri.chain_key ASC, f.occurred_at ASC, f.id ASC',
      limit,
      offset,
    })}
  `,
    queryParams
  );

  // Count distinct chains via the resolver's stable `chain_key`, not expanded
  // rows: a chain is an atomic unit and paging must never split it. Joining
  // resolved_ids also re-applies the same org/entity/visibility WHERE to the
  // counted set, so it can't drift from the list above.
  const countResult = await sql.unsafe(
    `
    WITH ${RESOLVED_IDS_CTE}
    SELECT COUNT(DISTINCT ri.chain_key) as total
    FROM events f
    JOIN resolved_ids ri ON ri.id = f.id
    LEFT JOIN connections c ON c.id = f.connection_id
    WHERE ${where}
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
  if (args.analyzed_by_watcher_id !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM watcher_window_events iwf WHERE iwf.event_id = e.id AND iwf.watcher_id = $${paramIndex})`
    );
    queryParams.push(args.analyzed_by_watcher_id);
    paramIndex += 1;
  }
  if (args.exclude_watcher_id !== undefined) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM watcher_window_events exc_iwe WHERE exc_iwe.event_id = e.id AND exc_iwe.watcher_id = $${paramIndex})`
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
  if (args.agent_id) {
    conditions.push(`e.metadata->>'agent_id' = $${paramIndex}`);
    queryParams.push(args.agent_id);
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
  if (args.analyzed_by_watcher_id !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM watcher_window_events iwf WHERE iwf.event_id = f.id AND iwf.watcher_id = $${paramIndex++})`
    );
    params.push(args.analyzed_by_watcher_id);
  }
  if (args.exclude_watcher_id !== undefined) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM watcher_window_events exc_iwe WHERE exc_iwe.event_id = f.id AND exc_iwe.watcher_id = $${paramIndex++})`
    );
    params.push(args.exclude_watcher_id);
  }
  if (args.agent_id) {
    conditions.push(`f.metadata->>'agent_id' = $${paramIndex++}`);
    params.push(args.agent_id);
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
      -- P4: dedup per (event, stable classifier_id) directly; version ordering is redundant.
      SELECT
        cc.event_id,
        cc.classifier_id,
        cc."values",
        ROW_NUMBER() OVER (
          PARTITION BY cc.event_id, cc.classifier_id
          ORDER BY
            CASE cc.source WHEN 'user' THEN 1 WHEN 'llm' THEN 2 ELSE 3 END,
            cc.created_at DESC
        ) as rn
      FROM event_classifications cc
      JOIN matching_content mc ON mc.id = cc.event_id
      WHERE cc.classifier_id IS NOT NULL
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
    JOIN classify_facet fcl ON lc.classifier_id = fcl.id
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
