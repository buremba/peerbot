/**
 * Tool: read_knowledge — watcher mode.
 *
 * When watcher_id is provided, fetch content for all of the watcher's
 * sources, compute the pending window, and generate a window_token for the
 * complete_window action (plus condensation rollups).
 */

import type { ContentItem } from '@lobu/connector-sdk';
import { getNextWatcherGranularity, inferWatcherGranularityFromSchedule } from '@lobu/connector-sdk';
import { type DbClient, parsePgNumberArray } from '../../db/client';
import type { Env } from '../../index';
import type { UnprocessedRange, WatcherSource } from '../../types/watchers';
import { parseDateAlias, toEndOfDay } from '../../utils/date-aliases';
import { type DataSourceContext, executeDataSources } from '../../utils/execute-data-sources';
import logger from '../../utils/logger';
import { getRecentFeedbackSummary } from '../../utils/watcher-feedback';
import { getAvailableOperations, getPastReactionsSummary } from '../../utils/watcher-reactions';
import {
  computePendingWindow,
  foldUnprocessedRanges,
  queryUncondensedWindows,
} from '../../utils/window-utils';
import type { GetContentArgs } from './schema';
import type { ClassifierConfig, GetContentResult } from './types';
import { parseJson, parseRecordArray } from './types';

// ============================================
// Content Query (inlined from watcher-content-query)
// ============================================

interface ContentQueryParams {
  sources: WatcherSource[];
  window_start: string;
  window_end: string;
  organizationId: string;
  entityIds?: number[];
  page?: {
    sourceName: string;
    limit: number;
    beforeOccurredAt?: string;
    beforeId?: number;
  };
}

async function queryContentData(
  sql: DbClient,
  params: ContentQueryParams
): Promise<{
  sourcesContent: Record<string, unknown[]>;
  allContent: unknown[];
  page?: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } };
}> {
  const page = params.page;
  const queryContext: DataSourceContext = {
    organizationId: params.organizationId,
    entityIds: params.entityIds,
    windowStart: params.window_start,
    windowEnd: params.window_end,
  };
  const results = await executeDataSources(params.sources, queryContext, sql, {
    wrapQuery: page
      ? (scopedQuery, queryParams, sourceName) => {
          if (sourceName !== page.sourceName) return scopedQuery;

          const nextParams = [...queryParams];
          const where: string[] = [
            '_watcher_page.id IS NOT NULL',
            '_watcher_page.occurred_at IS NOT NULL',
          ];
          if (page.beforeOccurredAt && page.beforeId) {
            nextParams.push(page.beforeOccurredAt);
            const occurredAtParam = `$${nextParams.length}`;
            nextParams.push(page.beforeId);
            const idParam = `$${nextParams.length}`;
            where.push(
              `(_watcher_page.occurred_at < ${occurredAtParam}::timestamptz OR ` +
                `(_watcher_page.occurred_at = ${occurredAtParam}::timestamptz AND _watcher_page.id < ${idParam}::bigint))`
            );
          }
          nextParams.push(page.limit + 1);
          const limitParam = `$${nextParams.length}`;

          return {
            // security-allowed: scopedQuery is an internally-built SQL fragment; where[] entries use $N placeholders.
            sql:
              `SELECT * FROM (${scopedQuery}) AS _watcher_page ` +
              `WHERE ${where.join(' AND ')} ` +
              'ORDER BY _watcher_page.occurred_at DESC NULLS LAST, _watcher_page.id DESC ' +
              `LIMIT ${limitParam}`,
            params: nextParams,
          };
        }
      : undefined,
  });

  let pageResult: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } } | undefined;
  if (page) {
    const rows = results[page.sourceName] ?? [];
    const trimmed = rows.slice(0, page.limit);
    const hasMore = rows.length > page.limit;
    results[page.sourceName] = trimmed;
    const last = trimmed[trimmed.length - 1] as Record<string, unknown> | undefined;
    const lastOccurredAt = last?.occurred_at;
    const lastId = Number(last?.id);
    pageResult = {
      has_more: hasMore,
      ...(hasMore && lastOccurredAt && Number.isFinite(lastId)
        ? {
            next_cursor: {
              occurred_at: new Date(lastOccurredAt as string | Date).toISOString(),
              id: Math.trunc(lastId),
            },
          }
        : {}),
    };
  }

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

  return { sourcesContent: results as Record<string, unknown[]>, allContent, page: pageResult };
}

// ============================================
// Watcher Mode Handler
// ============================================

export async function handleWatcherMode(
  args: GetContentArgs,
  env: Env,
  sql: DbClient
): Promise<GetContentResult> {
  const { generateWindowToken } = await import('../../utils/jwt');

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
        content_count: 0,
        content_ids: [],
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

  const watcherEntityIds = parsePgNumberArray(watcher.entity_ids);
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
      cc.extraction_config,
      cc.attribute_values
    FROM classify_facet cc
    WHERE cc.watcher_id = ${watcherId}
      AND cc.status = 'active'
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

  const contentLimit = Math.min(Math.max(args.limit || 100, 1), 1000); // Page size; agents can request more pages with next_cursor.
  const contentOffset = args.offset || 0;
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
      organizationId: watcher.organization_id as string,
      entityIds: watcherEntityIds,
      page: {
        sourceName: 'content',
        limit: contentLimit,
        beforeOccurredAt: args.before_occurred_at,
        beforeId: args.before_id,
      },
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
  const { sourcesContent, allContent, page: contentPage } = contentData;
  const totalCount = Number(totalStatsResult[0]?.total_count || 0);
  const totalCountChars = Number(totalStatsResult[0]?.total_chars || 0);

  const contentIds = allContent
    .map((item) => Number((item as Record<string, unknown>).id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.trunc(id));

  // Generate signed JWT window token with the exact content IDs returned to
  // the worker. complete_window uses these IDs directly, so window bookkeeping
  // matches what the agent actually saw.
  // NOTE: window_id is NOT included - it will be created by complete_window.
  const windowToken = await generateWindowToken(
    {
      watcher_id: watcherId,
      window_start: windowStartIso,
      window_end: windowEndIso,
      granularity: timeGranularity,
      content_count: contentIds.length,
      content_ids: contentIds,
    },
    env
  );

  // Render template prompt if available
  let promptRendered: string | undefined;
  if (templatePrompt) {
    const { renderPromptTemplate } = await import('../../watchers/template-renderer');

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

    unprocessedRanges = foldUnprocessedRanges(
      monthlyContent as Array<{ month: string; total: number | string }>,
      monthlyLinked as Array<{ month: string; linked: number | string }>,
      true
    );

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
  if (enrichedPrompt && contentPage?.has_more) {
    enrichedPrompt +=
      '\n\n## Pagination\n' +
      `This page includes ${allContent.length} content items and more items are available in this same watcher window. ` +
      'If you need more evidence before completing the window, call read_knowledge again with the same watcher_id/since/until and page.next_cursor as before_occurred_at/before_id.';
  }
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
    total: contentIds.length,
    page: {
      limit: contentLimit,
      offset: contentOffset,
      has_more: contentPage?.has_more ?? false,
      ...(contentPage?.next_cursor ? { next_cursor: contentPage.next_cursor } : {}),
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
