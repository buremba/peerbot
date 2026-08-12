/**
 * Tool: read_knowledge — behavior mode.
 *
 * When behavior_id is provided, fetch content for all of the watcher's
 * sources, compute the pending window, and generate a window_token for the
 * complete_window action.
 */

import { createHash } from 'node:crypto';
import type { ContentItem } from '@lobu/connector-sdk';
import { inferBehaviorGranularityFromSchedule } from '@lobu/connector-sdk';
import { MAX_COALESCED_BEHAVIOR_EVENT_INPUTS } from '../../behaviors/workspace-event-contract';
import { type DbClient, parsePgNumberArray } from '../../db/client';
import type { Env } from '../../index';
import type { Outputs, UnprocessedRange, WatcherSource } from '../../types/watchers';
import { ToolUserError } from '../../utils/errors';
import { type DataSourceContext, executeDataSources } from '../../utils/execute-data-sources';
import logger from '../../utils/logger';
import { runMetric } from '../../metrics/run-metric';
import { getRecentFeedbackSummary } from '../../utils/watcher-feedback';
import { getAvailableOperations, getPastReactionsSummary } from '../../utils/watcher-reactions';
import { deriveWatcherExtractionSchema } from '../../utils/watcher-extraction-schema';
import {
  alignRequestedWindow,
  computePendingWindow,
  computeWindowLag,
  describeWindowLag,
  foldUnprocessedRanges,
  parseBehaviorWindowDate,
  readWindowCursor,
} from '../../utils/window-utils';
import {
  DEFAULT_BEHAVIOR_SOURCE_QUERY,
  type NormalizedWatcherSource,
  normalizeWatcherSources,
} from '../../watchers/source-refs';
import type { GetContentArgs } from './schema';
import type { ClassifierConfig, GetContentResult } from './types';
import { parseJson, parseRecordArray } from './types';
import { stableJson } from '../../utils/insert-event';

// ============================================
// Content Query (inlined from watcher-content-query)
// ============================================

interface ContentQueryParams {
  sources: WatcherSource[];
  window_start: string;
  window_end: string;
  organizationId: string;
  /**
   * Connection-visibility principal. A null principal sees org-visible
   * connections only.
   */
  userId: string | null;
  entityIds?: number[];
  query?: Record<string, string>;
  minimumSourceLimits?: Record<string, number>;
  /**
   * The Behavior these sources belong to. Its own output is excluded from the
   * result — see `excludeProducedByBehaviorId` in execute-data-sources.
   */
  behaviorId: number;
	throwOnSourceError?: boolean;
  /** Exclude workspace-identity audit rows for ordinary-member reads. */
  excludeWorkspaceAudit?: boolean;
  page?: {
    sourceName: string;
    limit: number;
    beforeOccurredAt?: string;
    beforeId?: number;
  };
}

function isMetricSource(
  source: NormalizedWatcherSource
): source is NormalizedWatcherSource & {
  ref: { type: 'metric'; entityType: string; measure: string };
} {
  return source.kind === 'metric' && source.ref?.type === 'metric';
}

async function queryContentData(
  sql: DbClient,
  params: ContentQueryParams
): Promise<{
  sourcesContent: Record<string, unknown[]>;
  allContent: unknown[];
  page?: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } };
  sourcesPage: Record<string, { returned: number; limit: number; has_more: boolean }>;
  totalCount: number;
  totalCountChars: number;
}> {
  const page = params.page;
  const queryContext: DataSourceContext = {
    organizationId: params.organizationId,
    userId: params.userId,
    entityIds: params.entityIds,
    query: params.query,
    windowStart: params.window_start,
    windowEnd: params.window_end,
    excludeProducedByBehaviorId: params.behaviorId,
  };
  const normalizedSources = await normalizeWatcherSources(
    sql,
    params.organizationId,
    params.sources
  );
  const eventSourceNames = new Set(
    normalizedSources.filter((source) => source.kind === 'event').map((source) => source.name)
  );
  const sqlSources = normalizedSources
    .filter((source) => source.kind !== 'metric')
    .map(({ name, query }) => ({ name, query }));
  // Every SQL-backed source is part of the agent-facing knowledge.read payload,
  // including context:true entity rows and streaming channel context. Bound all
  // of them when this is a paged read so one large context source cannot turn a
  // 25-row Behavior read into a six-figure-token model request. Metric sources
  // are already aggregate outputs and bypass executeDataSources.
  const boundedSourceNames = new Set(sqlSources.map((source) => source.name));
  const metricSources = normalizedSources.filter(isMetricSource);

  const results = await executeDataSources(sqlSources, queryContext, sql, {
    throwOnError: params.throwOnSourceError,
    excludeWorkspaceAudit: params.excludeWorkspaceAudit,
    wrapQuery: page
      ? (scopedQuery, queryParams, sourceName) => {
          const isEventSource = eventSourceNames.has(sourceName);
          const isCursorSource = isEventSource && sourceName === page.sourceName;
          const sourceLimit = Math.max(
            page.limit,
            params.minimumSourceLimits?.[sourceName] ?? 0
          );
          const nextParams = [...queryParams];

          // Context sources do not share the event cursor contract (their id may
          // be an entity id and they may not expose occurred_at). They still get
          // the same row budget plus one sentinel so sources_page can state
          // explicitly when the payload was truncated. Fingerprinting does not
          // pass page, so skip_if_unchanged still sees the complete source state.
          if (!isEventSource) {
            nextParams.push(sourceLimit + 1);
            const limitParam = `$${nextParams.length}`;
            return {
              // security-allowed: scopedQuery is an internally-built, already-scoped SQL fragment.
              sql: `SELECT * FROM (${scopedQuery}) AS _watcher_context LIMIT ${limitParam}`,
              params: nextParams,
            };
          }

          // Event sources retain keyset pagination. Only the named primary source
          // carries a cursor; every event source is still bounded.
          const where: string[] = [
            '_watcher_page.id IS NOT NULL',
            '_watcher_page.occurred_at IS NOT NULL',
          ];
          if (isCursorSource && page.beforeOccurredAt && page.beforeId) {
            nextParams.push(page.beforeOccurredAt);
            const occurredAtParam = `$${nextParams.length}`;
            nextParams.push(page.beforeId);
            const idParam = `$${nextParams.length}`;
            where.push(
              `(_watcher_page.occurred_at < ${occurredAtParam}::timestamptz OR ` +
                `(_watcher_page.occurred_at = ${occurredAtParam}::timestamptz AND _watcher_page.id < ${idParam}::bigint))`
            );
          }
          nextParams.push(sourceLimit + 1);
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
  await Promise.all(
    metricSources.map(async (source) => {
      try {
        results[source.name] = await runMetric({
          organizationId: params.organizationId,
          entityType: source.ref.entityType,
          measure: source.ref.measure,
          userId: params.userId,
          excludeWorkspaceAudit: params.excludeWorkspaceAudit,
        });
      } catch (err) {
		if (params.throwOnSourceError) throw err;
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            dataSource: source.name,
          },
          'Metric source execution failed'
        );
        results[source.name] = [];
      }
    })
  );

  // Source-aware totals for token estimation. The old count was keyed on the
  // watcher's entity_ids, which read 0 for @feed / @connection / org-scoped
  // watchers even when content existed. Count over each normalized event source,
  // scoped the same way as the content query (org / entity_ids / window).
  // @metric / @entity sources are context, not content, so they're excluded.
  // Char estimates use to_jsonb(row)->>'payload_text' so custom SQL/default
  // sources still contribute when they project payload_text, but safely count 0
  // when they don't.
  const statsEventSources = normalizedSources.filter((source) => source.kind === 'event');
  let totalCount = 0;
  let totalCountChars = 0;
  if (statsEventSources.length > 0) {
    const statsSources = statsEventSources.map((source, idx) => {
      const alias = `__stats_s_${idx}`;
      return {
        name: `__stats_${idx}`,
        // security-allowed: source.query is an internally-built SQL fragment
        // (org-scoped eventSelect for refs, or caller-SQL that already passed
        // read-only validation + id-projection guard at save time).
        query: `SELECT COUNT(*)::int AS c, COALESCE(SUM(LENGTH(to_jsonb(${alias})->>'payload_text')), 0)::bigint AS ch FROM (${source.query}) AS ${alias}`,
      };
    });
    const statsResults = await executeDataSources(statsSources, queryContext, sql, {
      // Totals must respect the same workspace-audit boundary as the returned
      // rows, else an ordinary member infers audit rows from the count.
      excludeWorkspaceAudit: params.excludeWorkspaceAudit,
    });
    for (const rows of Object.values(statsResults)) {
      const row = rows[0] as { c?: number; ch?: string | number } | undefined;
      if (row) {
        totalCount += Number(row.c || 0);
        totalCountChars += Number(row.ch || 0);
      }
    }
  }

  let pageResult: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } } | undefined;
  // Per-source truncation. Every SQL-backed source fetches `limit + 1` rows
  // to detect overflow. Context sources have no event cursor, but sources_page
  // still reports that they were capped instead of silently injecting the full
  // result set into the model turn.
  const sourcesPage: Record<string, { returned: number; limit: number; has_more: boolean }> = {};
  if (page) {
    for (const sourceName of boundedSourceNames) {
      if (sourceName === page.sourceName && eventSourceNames.has(sourceName)) continue;
      const rows = results[sourceName] ?? [];
      const sourceLimit = Math.max(
        page.limit,
        params.minimumSourceLimits?.[sourceName] ?? 0
      );
      const hasMore = rows.length > sourceLimit;
      if (hasMore) results[sourceName] = rows.slice(0, sourceLimit);
      sourcesPage[sourceName] = {
        returned: (results[sourceName] ?? []).length,
        limit: sourceLimit,
        has_more: hasMore,
      };
    }

    // Only an event source can carry the chronological keyset cursor. Some
    // Behaviors deliberately name their primary event source something other
    // than "content"; those sources are still bounded above and report
    // sources_page.has_more, but no fake cursor row is synthesized.
    if (eventSourceNames.has(page.sourceName)) {
      const rows = results[page.sourceName] ?? [];
      const trimmed = rows.slice(0, page.limit);
      const hasMore = rows.length > page.limit;
      results[page.sourceName] = trimmed;
      const last = trimmed[trimmed.length - 1] as Record<string, unknown> | undefined;
      const lastOccurredAt = last?.occurred_at;
      const lastId = Number(last?.id);
      sourcesPage[page.sourceName] = {
        returned: trimmed.length,
        limit: page.limit,
        has_more: hasMore,
      };
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
  }

  const seen = new Set<number>();
  const allContent: unknown[] = [];

  for (const [sourceName, rows] of Object.entries(results)) {
    if (!eventSourceNames.has(sourceName)) continue;
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

  return {
    sourcesContent: results as Record<string, unknown[]>,
    sourcesPage,
    allContent,
    page: pageResult,
    totalCount,
    totalCountChars,
  };
}

/**
 * Cheap-vs-LLM schedule gate: execute the same normalized sources used by
 * read_knowledge and fingerprint their JSON rows. No model is called. The
 * A skipped window is persisted as durable zero-content cursor progress, so
 * subsequent ticks fingerprint the next period instead of retrying stale time.
 */
export async function fingerprintWatcherSources(args: {
  sql: DbClient;
  watcherId: number;
  windowStart: string;
  windowEnd: string;
}): Promise<{ fingerprint: string; empty: boolean }> {
  const rows = await args.sql`
    SELECT w.organization_id, w.entity_ids, w.sources, w.created_by, v.version_sources
    FROM watchers w
    LEFT JOIN watcher_versions v ON v.id = w.current_version_id
    WHERE w.id = ${args.watcherId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`Behavior ${args.watcherId} not found`);
  const versionSources = parseJson(row.version_sources) || [];
  const sources = (
    versionSources.length > 0 ? versionSources : parseJson(row.sources) || []
  ) as WatcherSource[];
  const result = await queryContentData(args.sql, {
    sources,
    window_start: args.windowStart,
    window_end: args.windowEnd,
    organizationId: String(row.organization_id),
    // Scheduled fingerprinting is a read on behalf of the Behavior author.
    // Without that durable principal, private sources look permanently empty.
    userId: row.created_by as string,
    entityIds: parsePgNumberArray(row.entity_ids),
    // Excluded here too, and not only for symmetry: `skip_if_unchanged`
    // fingerprints these rows, so a Behavior that saw its own output would
    // register its own write as a change and re-fire on every tick forever.
    behaviorId: args.watcherId,
	throwOnSourceError: true,
  });
  const sourceState = Object.fromEntries(
    Object.entries(result.sourcesContent).map(([sourceName, sourceRows]) => [
      sourceName,
      sourceRows
        .filter((sourceRow) => {
          if (typeof sourceRow !== 'object' || sourceRow === null) return true;
          const record = sourceRow as Record<string, unknown>;
          if (record.semantic_type !== 'canvas_state') return true;
          const metadata = record.metadata;
          return !(
            typeof metadata === 'object' &&
            metadata !== null &&
            Number((metadata as Record<string, unknown>).watcher_id) === args.watcherId
          );
        })
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    ])
  );
  const fingerprint = createHash('sha256')
    .update(stableJson(sourceState))
    .digest('hex');
  const empty = Object.values(sourceState).every(
    (sourceRows) => !Array.isArray(sourceRows) || sourceRows.length === 0
  );
  return { fingerprint, empty };
}

// ============================================
// Behavior Mode Handler
// ============================================

export async function handleBehaviorMode(
  args: GetContentArgs,
  env: Env,
  sql: DbClient,
  context: {
    organizationId: string;
    /** Verified caller, or null when the read is a headless Behavior run. */
    userId: string | null;
    /** Exclude workspace-identity audit rows for ordinary-member reads. */
    excludeWorkspaceAudit?: boolean;
  }
): Promise<GetContentResult> {
  const { generateWindowToken } = await import('../../utils/jwt');

  const watcherId = args.behavior_id!;

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
      i.created_by,
      i.organization_id,
      cv.outputs as template_outputs,
      cv.reactions_guidance,
      cv.version_sources,
      (SELECT COALESCE(json_agg(json_build_object('id', e.id, 'name', e.name, 'type', et.slug, 'metadata', e.metadata, 'field_controls', e.field_controls)), '[]'::json) FROM entities e JOIN entity_types et ON et.id = e.entity_type_id WHERE e.id = ANY(i.entity_ids)) as entities
    FROM watchers i
    LEFT JOIN watcher_versions cv
      ON cv.id = COALESCE(${pinnedVersionId}::bigint, i.current_version_id)
     AND cv.watcher_id = i.watcher_group_id
    WHERE i.id = ${watcherId}
      AND i.organization_id = ${context.organizationId}
    LIMIT 1
  `;

  if (watcherResult.length === 0) {
    throw new Error(`Behavior ${watcherId} not found`);
  }

  const watcher = watcherResult[0];

  const versionSources = parseJson(watcher.version_sources) || [];
  const watcherSources =
    versionSources.length > 0 ? versionSources : parseJson(watcher.sources) || [];
  const timeGranularity = inferBehaviorGranularityFromSchedule(watcher.schedule as string | null);
  // The extraction contract is composed from versioned outputs and the
  // optional reaction input contract.
  const templateExtractionSchema = await deriveWatcherExtractionSchema(
    sql,
    watcher.organization_id as string,
    parseJson(watcher.template_outputs) as Outputs | null,
    watcherId
  );

  const watcherEntityIds = parsePgNumberArray(watcher.entity_ids);
  let sources: WatcherSource[];
  if (watcherSources.length > 0) {
    sources = watcherSources;
  } else {
    sources = [{ name: 'content', query: DEFAULT_BEHAVIOR_SOURCE_QUERY }];
  }

  // A workspace-sourced event window receives exact durable pointers in addition to
  // its authored context sources. Include those rows in the same Behavior read
  // so the returned window_token proves what the agent saw and complete_window
  // can link or cite the triggering events normally.
  //
  // The rows stay governed: this source reads the same
  // org/window/entity-scoped `events` CTE as every authored source, so an id
  // outside the Behavior's scope resolves to no row rather than to unscoped
  // data. The exact ids travel through the data-source placeholder compiler so
  // they remain bound parameters instead of executable SQL text.
  const triggerContentIds = [
    ...new Set(
      (args.content_ids ?? [])
        .map((id) => Number(id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
  let triggerInputSourceName: string | null = null;
  if (triggerContentIds.length > MAX_COALESCED_BEHAVIOR_EVENT_INPUTS) {
    throw new ToolUserError(
      `Behavior event windows accept at most ${MAX_COALESCED_BEHAVIOR_EVENT_INPUTS} exact trigger inputs.`,
      422
    );
  }
  if (triggerContentIds.length > 0) {
    const occupiedNames = new Set(sources.map((source) => source.name));
    let sourceName = '__event_inputs';
    for (let suffix = 2; occupiedNames.has(sourceName); suffix++) {
      sourceName = `__event_inputs_${suffix}`;
    }
    triggerInputSourceName = sourceName;
    sources = [
      {
        name: sourceName,
        query: `SELECT * FROM events
          WHERE id = ANY(string_to_array({{query.eventContentIds}}, ',')::bigint[])
          ORDER BY occurred_at DESC`,
      },
      ...sources,
    ];
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
  let windowStart: Date, windowEnd: Date, windowCursor: Date | null;
  if (args.since && args.until) {
    // An agent-chosen range, aligned to the granularity so an agent-written
    // window is indistinguishable in shape from a server-computed one.
    ({ windowStart, windowEnd } = alignRequestedWindow(
      parseBehaviorWindowDate(args.since),
      parseBehaviorWindowDate(args.until),
      timeGranularity
    ));
    windowCursor = await readWindowCursor(sql, watcherId);
  } else {
    ({ windowStart, windowEnd, cursor: windowCursor } = await computePendingWindow(
      sql,
      watcherId,
      timeGranularity
    ));
  }

  // How the window being handed out sits against the clock, and which periods
  // (if any) were skipped to produce it. Measured against the WINDOW, not the
  // cursor: at the moment a run reads, the cursor is the period the PREVIOUS run
  // completed, so a healthy daily Behavior is two periods behind by that measure
  // and one by this one.
  const windowLag = computeWindowLag(windowCursor, windowStart, new Date(), timeGranularity);
  const windowLagNote = describeWindowLag({
    skippedFrom: windowLag.skippedFrom,
    skippedTo: windowLag.skippedTo,
    periodsSkipped: windowLag.periodsSkipped,
    granularity: timeGranularity,
  });

  // NOTE: Window creation is deferred to complete_window action
  // This allows batched processing where each batch creates its own window

  const contentLimit = Math.min(Math.max(args.limit || 100, 1), 1000); // Page size; agents can request more pages with next_cursor.
  const contentOffset = args.offset || 0;
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  const sourceEntityIds = watcherEntityIds;
  const entityIdPlaceholders = sourceEntityIds.map((_, i) => `$${i + 1}`).join(',');

  // A headless Behavior run acts on behalf of its durable author. Interactive
  // reads keep the verified caller's own connection visibility.
  const visibilityUserId = context.userId ?? (watcher.created_by as string);

  // Run content query and total stats in parallel
  const contentData = await queryContentData(sql, {
    sources,
    window_start: windowStartIso,
    window_end: windowEndIso,
    organizationId: watcher.organization_id as string,
    userId: visibilityUserId,
    entityIds: watcherEntityIds,
    query:
      triggerContentIds.length > 0
        ? { eventContentIds: triggerContentIds.join(',') }
        : undefined,
    minimumSourceLimits: triggerInputSourceName
      ? { [triggerInputSourceName]: triggerContentIds.length }
      : undefined,
    behaviorId: Number(watcher.id),
    excludeWorkspaceAudit: context.excludeWorkspaceAudit,
    page: {
      sourceName: 'content',
      limit: contentLimit,
      beforeOccurredAt: args.before_occurred_at,
      beforeId: args.before_id,
    },
  });
  const {
    sourcesContent,
    allContent,
    page: contentPage,
    sourcesPage,
    totalCount,
    totalCountChars,
  } = contentData;

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

  // Bound entities ride the payload as structured rows (id, name, type,
  // metadata, field_controls) — field_controls marks human-owned field values
  // the agent must not clobber without new evidence.
  const boundEntities: unknown[] = Array.isArray(watcher.entities)
    ? watcher.entities
    : (parseJson(watcher.entities) ?? []);

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
        WHERE c.entity_ids && ARRAY[${entityIdPlaceholders}]::bigint[]
          AND iwc.watcher_id = $${sourceEntityIds.length + 1}
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
    logger.warn({ err }, '[get_content] Failed to fetch reaction data for behavior mode');
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
    window_lag: {
      last_window_start: windowCursor ? windowCursor.toISOString() : null,
      current_period_start: windowLag.currentPeriodStart.toISOString(),
      periods_behind: windowLag.periodsBehind,
      granularity: timeGranularity,
      periods_skipped: windowLag.periodsSkipped,
      skipped_from: windowLag.skippedFrom ? windowLag.skippedFrom.toISOString() : null,
      skipped_to: windowLag.skippedTo ? windowLag.skippedTo.toISOString() : null,
      // The numbers alone did not change what a run did (see describeWindowLag).
      // Behavior runs read this through run_sdk as JSON, so the guidance has to
      // be IN the payload, not only in the markdown a tool-call client renders.
      ...(windowLagNote ? { guidance: windowLagNote } : {}),
    },
    extraction_schema: templateExtractionSchema ?? undefined,
    sources: sourcesContent as Record<string, ContentItem[]>,
    // Per-source page state. Every SQL-backed source is capped at `limit`, so
    // this is how a caller tells a fully-read source from a truncated one.
    sources_page: sourcesPage,
    entities: boundEntities.length > 0 ? boundEntities : undefined,
    classifiers: classifiers.length > 0 ? classifiers : undefined,
    unprocessed_ranges: unprocessedRanges,
    reactions_guidance: reactionsGuidance,
    past_reactions: pastReactions,
    past_feedback: pastFeedback,
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
