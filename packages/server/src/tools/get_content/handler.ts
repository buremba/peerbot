/**
 * Tool: read_knowledge — main handler.
 *
 * List or search content for an entity.
 * Provide `query` parameter to perform semantic/full-text search.
 * Omit `query` to list all content with filters.
 */

import type { ContentItem } from '@lobu/connector-sdk';
import { hasRequiredMcpScope } from '../../auth/tool-access';
import { createDbClientFromEnv, getDb } from '../../db/client';
import type { Env } from '../../index';
import { ToolUserError } from '../../utils/errors';
import {
  getNormalizedScoreContent,
  getNormalizedScoreContentCount,
} from '../../utils/content-scoring';
import { searchContentByText } from '../../utils/content-search';
import { parseDateAlias, toEndOfDay } from '../../utils/date-aliases';
import logger from '../../utils/logger';
import { requireReadAccess } from '../../utils/organization-access';
import { rewriteQueries } from '../../utils/query-rewriter';
import {
  buildContentUrl,
  type EntityInfo,
  getOrganizationSlug,
  getPublicWebUrl,
} from '../../utils/url-builder';
import type { ToolContext } from '../registry';
import {
  fetchByContentIds,
  fetchClassificationStats,
  fetchIncludeSuperseded,
} from './query';
import { buildContentItems, fetchClassificationExcerpts } from './render';
import { GetContentSchema, type GetContentArgs, getIncludeSupersededValidationErrors } from './schema';
import type { ContentRow, GetContentResult, IdRow } from './types';
import { handleWatcherMode } from './watcher-mode';
import { withValidatedArgs } from '../validate-args';

// ============================================
// Main Function
// ============================================

export const getContent = withValidatedArgs('read_knowledge', GetContentSchema, getContentImpl);

async function getContentImpl(
  args: GetContentArgs,
  env: Env,
  ctx: ToolContext
): Promise<GetContentResult> {
  // SDK delegates (`client.knowledge.get`/`read`) skip `checkToolAccess`, so
  // re-enforce the mcp:read scope here — but only for MCP token callers
  // (oauth/pat). Session/anonymous/system callers carry no MCP scope dimension
  // (they're gated by member role + public-readability at the query level), which
  // mirrors how extractAuthContext assigns scopes: real scopes for oauth/pat, a
  // not-applicable sentinel otherwise.
  const isMcpTokenCaller = ctx.tokenType === 'oauth' || ctx.tokenType === 'pat';
  if (isMcpTokenCaller && !hasRequiredMcpScope('read', ctx.scopes)) {
    throw new ToolUserError('read_knowledge requires an MCP session with read access.', 403);
  }

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
      ({ rawContent, total, pageInfo } = await fetchByContentIds({
        args,
        sql,
        organizationId: ctx.organizationId,
        visibilityScope,
        limit,
        offset,
      }));
    } else if (args.include_superseded) {
      ({ rawContent, total, pageInfo } = await fetchIncludeSuperseded({
        args,
        sql,
        organizationId: ctx.organizationId,
        entityId,
        effectiveConnectionIds,
        effectivePlatform,
        sinceDate,
        untilDate,
        visibilityScope,
        limit,
        offset,
      }));
    } else if (args.sort_by === 'score' && entityId) {
      logger.info('[get_content] Using sophisticated multi-signal score ranking');

      const filters: Parameters<typeof getNormalizedScoreContent>[3] = {
        ...(effectiveConnectionIds?.length && { connection_ids: effectiveConnectionIds }),
        ...(args.feed_ids?.length && { feed_ids: args.feed_ids }),
        ...(args.run_ids?.length && { run_ids: args.run_ids }),
        ...(effectivePlatform && { platform: effectivePlatform }),
        ...(sinceDate && { since: sinceDate }),
        ...(untilDate && { until: untilDate }),
        ...(args.engagement_min !== undefined && { engagement_min: args.engagement_min }),
        ...(args.engagement_max !== undefined && { engagement_max: args.engagement_max }),
        ...(args.window_id !== undefined && { window_id: args.window_id }),
        ...(args.analyzed_by_watcher_id !== undefined && {
          analyzed_by_watcher_id: args.analyzed_by_watcher_id,
        }),
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

      const searchOptions = {
        entity_id: args.entity_id,
        organization_id: !args.entity_id ? ctx.organizationId : undefined,
        connection_ids: effectiveConnectionIds,
        feed_ids: args.feed_ids,
        run_ids: args.run_ids,
        ...(args.agent_id && { agent_id: args.agent_id }),
        visibility_scope: visibilityScope,
        window_id: args.window_id,
        analyzed_by_watcher_id: args.analyzed_by_watcher_id,
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
        entity_types: args.entity_types,
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
      };

      // Primary single-query search. A capable agent already phrases its own
      // search query, so this is the path the vast majority of calls take.
      const result = await searchContentByText(args.query ?? null, searchOptions, env);
      rawContent = result.content;
      total = result.total;
      pageInfo = result.page;

      // Auto recall-rescue: if a score-sorted text query found NOTHING on the
      // first page, the raw phrasing was likely too conversational/underspecified
      // to match. Expand it into LLM-rewritten keyword variants and fuse their
      // hits. Fires ONLY on a total miss, so the common (found-something) path
      // pays no extra LLM call or round-trip. Stateless per-request
      // (multi-replica-safe); date feeds, cursor pages, and deep windows keep
      // single-query semantics. Replaces the old opt-in `rewrite_query` param:
      // callers no longer reason about it — it self-heals on a miss.
      const FALLBACK_FETCH_CAP = 400;
      const fallbackEligible =
        rawContent.length === 0 &&
        !!args.query &&
        (args.sort_by ?? 'score') === 'score' &&
        !args.before_occurred_at &&
        !args.after_occurred_at &&
        offset === 0 &&
        limit <= FALLBACK_FETCH_CAP;
      const variants = fallbackEligible ? await rewriteQueries(args.query as string, env) : [];

      if (variants.length > 0 && args.query) {
        // Over-fetch per variant so fusion has a real candidate pool to re-rank
        // (a variant's best hit may sit past the caller's `limit` in its own
        // ranking), capped so a large caller limit can't fan out into tens of
        // thousands of rows. The raw query already returned nothing, so only the
        // variants are searched here.
        const fetchLimit = Math.min(Math.max(limit * 4, 40), FALLBACK_FETCH_CAP);
        const fusionOptions = { ...searchOptions, limit: fetchLimit, offset: 0 };

        // candidate pool: event id -> best (max-score) row seen across variants.
        const pool = new Map<number, { row: ContentRow; score: number }>();
        const fuseInto = (rows: ContentRow[]) => {
          for (const row of rows) {
            const score = row.combined_score ?? row.similarity ?? 0;
            const existing = pool.get(row.id);
            if (!existing || score > existing.score) {
              pool.set(row.id, { row, score });
            }
          }
        };

        // Sentinel: a variant whose fetch came back full may have more matches
        // beyond the cap, so the pool is a LOWER BOUND on the true fused total
        // and deep pages must not be reported as exhausted.
        let poolTruncated = false;
        for (const variant of variants) {
          const variantResult = await searchContentByText(variant, fusionOptions, env);
          fuseInto(variantResult.content);
          poolTruncated ||= variantResult.content.length >= fetchLimit;
        }

        const ranked = [...pool.values()].sort((a, b) => b.score - a.score).map((c) => c.row);

        // The caller's limit pages out of the FUSED ranking (offset is 0 here).
        rawContent = ranked.slice(0, limit);
        total = ranked.length;
        pageInfo = { limit, offset: 0, has_more: poolTruncated || ranked.length > limit };
      }
    }

    // Optionally fetch classification statistics (aggregated across ALL matching content, not just paginated results)
    let classificationStats: GetContentResult['classification_stats'] | undefined;
    if (includeClassificationSummary) {
      classificationStats = await fetchClassificationStats({
        args,
        sql,
        effectiveConnectionIds,
        effectivePlatform,
        sinceDate,
        untilDate,
        visibilityScope,
      });
    }

    // Fetch excerpts for evidence highlighting when filtering by a single classification value
    const excerptsMap = await fetchClassificationExcerpts(sql, classificationFilters, rawContent);

    // Map to the canonical content item shape used across the app.
    const contentItems: ContentItem[] = await buildContentItems({
      sql,
      rawContent,
      organizationId: ctx.organizationId,
      ownerSlug,
      baseUrl,
      excerptsMap,
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
