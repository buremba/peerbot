/**
 * Tool: get_watcher (Incremental Time Windows)
 *
 * Query a single watcher's analysis windows by date range and granularity.
 * Returns time-windowed watcher data from watcher_windows table.
 */

import {
  addWatcherPeriod,
  getFinerWatcherGranularities,
  inferWatcherGranularityFromSchedule,
  type WatcherTimeGranularity,
} from '@lobu/connector-sdk';
import { type Static, Type } from '@sinclair/typebox';
import { createDbClientFromEnv, getDb } from '../db/client';
import type { Env } from '../index';
import type {
  PendingAnalysis,
  WatcherMetadata,
  WatcherSource,
  WatcherVersionInfo,
  WatcherWindow,
} from '../types/watchers';
import {
  buildEntityLinkUnion,
  STANDARD_IDENTITY_NAMESPACES,
  type EntityIdentityScope,
} from '../utils/content-search';
import {
  daysBetween,
  formatDateISO,
  inferGranularity,
  parseDateAlias,
} from '../utils/date-aliases';
import { parseJsonObject } from '../utils/json';
import logger from '../utils/logger';
import { requireReadAccess } from '../utils/organization-access';

import { renderPromptPreview } from '../utils/template-renderer';
import { buildWatchersUrl, type EntityInfo, getPublicWebUrl } from '../utils/url-builder';
import {
  buildWindowsSelectClause,
  ensureNumber,
  parseBigintArray,
  queryUncondensedWindows,
} from '../utils/window-utils';
import { buildLatestWatcherRunJoinSql } from '../watchers/automation';
import { getWorkspaceProvider } from '../workspace';
import type { ToolContext } from './registry';

// ============================================
// Typebox Schema
// ============================================

export const GetWatcherSchema = Type.Object({
  watcher_id: Type.String({ description: 'Watcher ID to query' }),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Optional entity ID for access validation and URL context',
    })
  ),
  content_since: Type.Optional(
    Type.String({
      description:
        'Filter windows from this date. Supports: ISO 8601 ("2025-01-01"), named aliases ("yesterday", "last_week"), or relative ("7d", "30d", "1m", "1y")',
    })
  ),
  content_until: Type.Optional(
    Type.String({
      description:
        'Filter windows until this date. Supports: ISO 8601 ("2025-01-31"), named aliases ("today", "yesterday"), or relative ("7d", "30d", "1m", "1y")',
    })
  ),
  granularity: Type.Optional(
    Type.Union(
      [
        Type.Literal('daily'),
        Type.Literal('weekly'),
        Type.Literal('monthly'),
        Type.Literal('quarterly'),
      ],
      {
        description:
          'Filter by time granularity. If not provided, automatically infers from date range (≤14d→daily, ≤90d→weekly, ≤365d→monthly, >365d→quarterly)',
      }
    )
  ),
  template_version: Type.Optional(
    Type.Number({
      description:
        "Override template version *number* for viewing results. If not provided, uses the watcher's current pinned version. Useful for viewing results with a different renderer or schema. Prefer `template_version_id` when you need a stable reference (version numbers can change if a chain is reorganized).",
    })
  ),
  template_version_id: Type.Optional(
    Type.Number({
      description:
        "Pin to a specific watcher_versions.id. Workers receive this from runs.approved_input.version_id and pass it back so the agent loop reads the same version it extracted with, even if the group is edited mid-run.",
    })
  ),
  page: Type.Optional(Type.Number({ description: 'Page number for pagination (default: 1)' })),
  page_size: Type.Optional(
    Type.Number({ description: 'Results per page (default: 50, max: 500)' })
  ),
  include_classification: Type.Optional(
    Type.String({
      description: 'Include per-window classification stats. Use "summary" to enable.',
    })
  ),
  include_versions: Type.Optional(
    Type.Boolean({
      description:
        'Include the full available_versions list. Off by default; the edit sheet sets it true. Saves one query per page open.',
    })
  ),
  include_pending_ranges: Type.Optional(
    Type.Boolean({
      description:
        'Include pending_analysis.unprocessed_ranges (per-month histogram). Off by default; the summary view sets it true on expand. Saves two events-table aggregates per page open.',
    })
  ),
});

// ============================================
// Type Definitions
// ============================================

type GetWatcherArgs = Static<typeof GetWatcherSchema>;

interface WindowGap {
  start: string;
  end: string;
}

interface GetWatcherResult {
  windows: WatcherWindow[];
  watcher?: WatcherMetadata;
  pending_analysis?: PendingAnalysis;
  gaps?: WindowGap[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
  };
  metadata: {
    query_type: 'specific' | 'all_for_entity';
    date_range: {
      content_since: string | null;
      content_until: string | null;
    };
    granularity_filter: string | null;
    granularity_inferred: boolean;
    granularity_actual: string | null;
    granularity_fallback_used: boolean;
  };
  condensation?: {
    ready: boolean;
    uncondensed_count: number;
    required_count: number;
    window_range?: { start: string; end: string };
  };
  warnings?: string[];
  view_url?: string;
}

// ============================================
// Database Row Types (for query result typing)
// ============================================

/** Row type for window query results (from buildWindowsSelectClause) */
interface WindowRow {
  window_id: number;
  watcher_id: string;
  watcher_name: string;
  granularity: string;
  window_start: string;
  window_end: string;
  is_rollup: boolean;
  content_analyzed: number;
  extracted_data: Record<string, unknown> | null;
  model_used: string | null;
  client_id: string | null;
  run_metadata: Record<string, unknown> | null;
  execution_time_ms: number | null;
  created_at: string | null;
  version_id: number | null;
  json_template: unknown | null;
  total_count: number; // COUNT(*) OVER () — same value on every row
}

/** Row type for classification stats query results */
interface ClassificationStatsRow {
  window_id: number;
  classifier_slug: string;
  value: string;
  count: number;
}

/** Row type for watcher query */
interface WatcherQueryRow {
  watcher_id: string;
  name: string | null;
  slug: string | null;
  status: string;
  schedule: string | null;
  next_run_at: string | null;
  agent_id: string | null;
  scheduler_client_id: string | null;
  version: number;
  current_version_id: number | null;
  entity_ids: string | number[];
  sources: WatcherSource[] | null;
  reaction_script: string | null;
  condensation_prompt: string | null;
  condensation_window_count: number | null;
  organization_id: string | null;
  watcher_run_id: number | null;
  watcher_run_status: string | null;
  watcher_run_error: string | null;
  watcher_run_created_at: string | null;
  watcher_run_completed_at: string | null;
  // Selected version row (pinned current_version unless template_version overrides)
  sel_version_id: number | null;
  sel_version: number | null;
  sel_version_name: string | null;
  sel_version_description: string | null;
  sel_version_prompt: string | null;
  sel_version_extraction_schema: Record<string, unknown> | null;
  sel_version_version_sources: unknown;
  sel_version_classifiers: unknown;
  sel_version_json_template: unknown;
  // Latest window end (folded MAX(window_end) lookup)
  latest_window_end: string | null;
  // jsonb_agg of entities (folded entityCheck/watcherEntityQuery)
  entities:
    | Array<{
        id: string | number;
        name: string;
        entity_type: string;
        slug: string;
        parent_id: string | number | null;
        parent_slug: string | null;
        parent_entity_type: string | null;
        organization_id: string;
      }>
    | null;
  // jsonb_agg of identity scopes for primary entity
  entity_scopes: Array<{ namespace: string; identifier: string }> | null;
}

function parseWatcherSources(value: unknown): WatcherSource[] {
  if (Array.isArray(value)) return value as WatcherSource[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as WatcherSource[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function buildEntityInfo(entityRow: Record<string, unknown>): Promise<{
  entityInfoForUrl: EntityInfo | null;
  entityName: string | null;
  entityType: string | null;
}> {
  const organizationSlug = await getWorkspaceProvider().getOrgSlug(
    entityRow.organization_id as string
  );
  return {
    entityInfoForUrl: organizationSlug
      ? {
          ownerSlug: organizationSlug,
          entityType: entityRow.entity_type as string,
          slug: entityRow.slug as string,
          parentType: (entityRow.parent_entity_type as string) ?? null,
          parentSlug: (entityRow.parent_slug as string) ?? null,
        }
      : null,
    entityName: (entityRow.name as string) ?? null,
    entityType: (entityRow.entity_type as string) ?? null,
  };
}

// ============================================
// Tool Implementation
// ============================================

export async function getWatcher(
  args: GetWatcherArgs,
  env: Env,
  ctx: ToolContext
): Promise<GetWatcherResult> {
  const pgSql = createDbClientFromEnv(env);
  const sql = getDb();
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);

  // Validate entity access if entity_id provided (auth check stays on PG)
  if (args.entity_id) {
    await requireReadAccess(pgSql, args.entity_id, ctx);
  }
  const includeClassification = (args.include_classification || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  // Default to "summary" when nothing requested. The "timeline" value used to
  // ship a separate classification_timeline payload — that path was removed,
  // but we treat it as a summary alias so existing MCP callers passing
  // "timeline" or "summary,timeline" still get the per-window stats they were
  // already getting (deleting the timeline must not silently strip summary).
  const includeClassificationSummary =
    includeClassification.length === 0 ||
    includeClassification.includes('summary') ||
    includeClassification.includes('timeline');

  // ============================================
  // Step 1: Validate inputs
  // ============================================

  if (!args.watcher_id) {
    throw new Error('watcher_id is required. Use list_watchers to discover available watchers.');
  }

  // Entity resolution is deferred — for the typical case (only watcher_id
  // given), the watcher metadata query below already returns the watcher's
  // entities as a nested jsonb_agg, so we build entityInfoForUrl /
  // entitiesForTemplate from that single result rather than firing a
  // dedicated entity lookup.
  //
  // The exception is when args.entity_id is passed and we need to validate
  // the entity exists / is accessible — that's a cheap PK check we keep
  // up-front so we throw early. (The page doesn't pass entity_id on default
  // load, so this branch is rare.)
  let entityInfoForUrl: EntityInfo | null = null;
  let entitiesForTemplate: Array<{ name: string; type: string }> = [];

  if (args.entity_id) {
    const entityCheck = await sql`
      SELECT e.id, e.name, et.slug AS entity_type, e.slug, e.parent_id,
        parent.slug as parent_slug, pet.slug as parent_entity_type,
        e.organization_id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      LEFT JOIN entities parent ON e.parent_id = parent.id
      LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
      WHERE e.id = ${args.entity_id}
    `;

    if (entityCheck.length === 0) {
      throw new Error(`Entity with ID ${args.entity_id} not found`);
    }

    const info = await buildEntityInfo(entityCheck[0]);
    entityInfoForUrl = info.entityInfoForUrl;
    entitiesForTemplate = [{ name: info.entityName ?? '', type: info.entityType ?? '' }];
  }

  const page = Math.max(1, args.page || 1);
  const pageSize = Math.min(500, Math.max(1, args.page_size || 50));
  const offset = (page - 1) * pageSize;

  let parsedSince: string | undefined;
  let parsedUntil: string | undefined;
  let inferredGranularity: string | undefined;

  if (args.content_since) {
    parsedSince = formatDateISO(parseDateAlias(args.content_since).date);
  }

  if (args.content_until) {
    const endOfDay = new Date(parseDateAlias(args.content_until).date);
    endOfDay.setHours(23, 59, 59, 999);
    parsedUntil = endOfDay.toISOString();
  }

  if (!args.granularity && parsedSince && parsedUntil && !args.watcher_id) {
    const daysDiff = daysBetween(new Date(parsedSince), new Date(parsedUntil));
    inferredGranularity = inferGranularity(daysDiff);
    logger.info(
      `[get_watcher] Inferred granularity '${inferredGranularity}' from ${daysDiff}-day range (${parsedSince} to ${parsedUntil})`
    );
  }

  const finalGranularity = args.granularity || inferredGranularity;

  const whereClauses: string[] = [];
  const params: any[] = [];

  const addParam = (value: any): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (args.watcher_id) {
    whereClauses.push(`iw.watcher_id = ${addParam(args.watcher_id)}`);
  } else if (args.entity_id) {
    whereClauses.push(`${addParam(args.entity_id)} = ANY(i.entity_ids)`);
    whereClauses.push(`i.status = 'active'`);
  }

  if (parsedSince) {
    whereClauses.push(`iw.window_end >= ${addParam(parsedSince)}`);
  }

  if (parsedUntil) {
    whereClauses.push(`iw.window_start <= ${addParam(parsedUntil)}`);
  }

  if (finalGranularity) {
    whereClauses.push(`iw.granularity = ${addParam(finalGranularity)}`);
  }

  const whereClause = whereClauses.length > 0 ? whereClauses.join(' AND ') : '1=1';

  const windowsQuery = `
    ${buildWindowsSelectClause()}
    WHERE ${whereClause}
    ORDER BY iw.window_start DESC, iw.granularity ASC
    LIMIT ${addParam(pageSize)}
    OFFSET ${addParam(offset)}
  `;

  let windows = await sql.unsafe(windowsQuery, params);

  // ============================================
  // Step 3.5: Fallback to finer granularity if no windows found
  // ============================================

  let actualGranularity = finalGranularity;
  let usedFallback = false;

  if (windows.length === 0 && finalGranularity) {
    const granularityParamIndex = params.length - 2; // index of granularity param (before pageSize, offset)

    for (const fallbackGranularity of getFinerWatcherGranularities(
      finalGranularity as WatcherTimeGranularity
    )) {
      const fallbackParams = [...params];
      fallbackParams[granularityParamIndex - 1] = fallbackGranularity;

      const fallbackWindows = await sql.unsafe(windowsQuery, fallbackParams);

      if (fallbackWindows.length > 0) {
        logger.info(
          `[get_watcher] Fallback: No ${finalGranularity} windows found, showing ${fallbackWindows.length} ${fallbackGranularity} windows instead`
        );
        windows = fallbackWindows;
        actualGranularity = fallbackGranularity;
        usedFallback = true;
        break;
      }
    }
  }

  // ============================================
  // Step 4: Total window count for pagination
  // ============================================
  // Derived from `COUNT(*) OVER ()` baked into the windows SELECT — no
  // separate round-trip on the common path. The COUNT is attached to each
  // returned row, so when `OFFSET` skips past every match we lose the
  // count. Pi-review fix: fall back to a dedicated `COUNT(*)` only when
  // the page is empty AND we requested a non-zero offset (page > 1).
  // Page-1 empty pages legitimately mean "no matches → total 0".
  let totalCount =
    windows.length > 0 ? Number((windows[0] as unknown as WindowRow).total_count ?? 0) : 0;
  if (windows.length === 0 && offset > 0) {
    const countQuery = `
      SELECT COUNT(*) as count
      FROM watcher_windows iw
      JOIN watchers i ON iw.watcher_id = i.id
      LEFT JOIN watcher_versions cv ON i.current_version_id = cv.id
      WHERE ${whereClause}
    `;
    const countResult = await sql.unsafe(countQuery, params.slice(0, -2));
    totalCount = Number.parseInt(String(countResult[0].count), 10);
  }

  // ============================================
  // Step 4.5: Fetch classification stats for all windows
  // ============================================

  const typedWindows = windows as unknown as WindowRow[];
  const windowIds = typedWindows.map((w) => ensureNumber(w.window_id));
  const classificationStatsMap: Map<number, Record<string, Record<string, number>>> = new Map();

  // Fire watcher metadata query early (awaited after classification stats).
  // This single statement is the consolidated "Q-meta": watcher row +
  // condensation columns + selected version row + entities (with parent
  // info) + identity scopes for the watcher's primary entity + MAX(window_end)
  // + latest run via lateral. Replaces what used to be five separate
  // round-trips (entityCheck/watcherEntityQuery, watcher row, fetchEntityIdentityScopes,
  // MAX(window_end) lookup, version row).
  //
  // The version row is *the requested version* — usually the watcher's
  // pinned current_version, but the optional template_version arg can
  // override it. We pass the resolved version number as $2; when it equals
  // the pinned version, we read off `cv` directly (the join already there
  // for condensation columns); when it differs, the JOIN still resolves
  // the right row via (watcher_id, version) which is unique.
  //
  // Two override mechanisms:
  //   - template_version_id (preferred): an exact watcher_versions.id. Used
  //     by the worker run loop to read the snapshotted version even after a
  //     mid-run group edit. Joins by id so it works regardless of which
  //     watcher in the group owns the version row.
  //   - template_version (legacy): a version *number*. Resolves via the
  //     group's root watcher_id (watcher_group_id), since after the group-
  //     edit refactor version chains live on the group root, not on each
  //     non-root assignment.
  //
  // Tagged-template + sql.unsafe() inside the template breaks PGlite's
  // simple-query mode (prepare=false), so we keep this path as a single
  // unsafe call instead.
  const requestedVersion = args.template_version ?? null;
  const requestedVersionId = args.template_version_id ?? null;
  const namespacesLiteral = STANDARD_IDENTITY_NAMESPACES.map((n) => `'${n}'`).join(',');
  const watcherQueryPromise = args.watcher_id
    ? sql.unsafe(
        `
      SELECT
        i.id as watcher_id,
        i.name,
        i.slug,
        i.status,
        i.schedule,
        i.next_run_at,
        i.agent_id,
        i.scheduler_client_id,
        i.version,
        i.current_version_id,
        i.entity_ids,
        i.sources,
        i.reaction_script,
        cv.condensation_prompt,
        cv.condensation_window_count,
        i.organization_id,
        -- Selected version row (pinned current_version unless template_version overrides)
        sv.id as sel_version_id,
        sv.version as sel_version,
        sv.name as sel_version_name,
        sv.description as sel_version_description,
        sv.prompt as sel_version_prompt,
        sv.extraction_schema as sel_version_extraction_schema,
        sv.version_sources as sel_version_version_sources,
        sv.classifiers as sel_version_classifiers,
        sv.json_template as sel_version_json_template,
        -- Latest window end for the unprocessedCount bound
        (SELECT MAX(window_end) FROM watcher_windows WHERE watcher_id = i.id) as latest_window_end,
        -- Entities + parent info for entityInfoForUrl / entitiesForTemplate
        (SELECT jsonb_agg(jsonb_build_object(
          'id', e.id,
          'name', e.name,
          'entity_type', et.slug,
          'slug', e.slug,
          'parent_id', e.parent_id,
          'parent_slug', parent.slug,
          'parent_entity_type', pet.slug,
          'organization_id', e.organization_id
        ))
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        LEFT JOIN entities parent ON e.parent_id = parent.id
        LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
        WHERE e.id = ANY(i.entity_ids)) as entities,
        -- Identity scopes for the primary entity (entity_ids[1]) — drives
        -- the entity-link UNION in the unprocessedCount query.
        (SELECT jsonb_agg(jsonb_build_object('namespace', namespace, 'identifier', identifier))
         FROM entity_identities ei
         WHERE ei.entity_id = (i.entity_ids)[1]
           AND ei.deleted_at IS NULL
           AND ei.namespace IN (${namespacesLiteral})
        ) as entity_scopes,
        -- Latest run via lateral
        wr.id as watcher_run_id,
        wr.status as watcher_run_status,
        wr.error_message as watcher_run_error,
        wr.created_at as watcher_run_created_at,
        wr.completed_at as watcher_run_completed_at
      FROM watchers i
      LEFT JOIN watcher_versions cv ON i.current_version_id = cv.id
      LEFT JOIN watcher_versions sv
        ON sv.id = COALESCE(
             $3::bigint,
             (SELECT id FROM watcher_versions
                WHERE watcher_id = i.watcher_group_id
                  AND version = COALESCE($2::int, i.version)
                LIMIT 1)
           )
       AND sv.watcher_id = i.watcher_group_id
      ${buildLatestWatcherRunJoinSql('i', 'wr')}
      WHERE i.id = $1
    `,
        [args.watcher_id, requestedVersion, requestedVersionId]
      )
    : null;

  logger.info(
    { windowIds, includeClassificationSummary },
    '[get_watcher] Checking classification stats'
  );
  if (windowIds.length > 0 && includeClassificationSummary) {
    try {
      logger.info({ windowCount: windowIds.length }, '[get_watcher] Fetching classification stats');
      const statsResult = await sql.unsafe(
        `
        SELECT
          iwc.window_id,
          cc.slug as classifier_slug,
          value as value,
          CAST(COUNT(*) AS INTEGER) as count
        FROM watcher_window_events iwc
        JOIN event_classifications cls ON iwc.event_id = cls.event_id
        JOIN event_classifier_versions ccv ON cls.classifier_version_id = ccv.id
        JOIN event_classifiers cc ON ccv.classifier_id = cc.id
        CROSS JOIN unnest(cls."values") AS t(value)
        WHERE iwc.window_id IN (${windowIds.map((_: unknown, i: number) => `$${i + 1}`).join(', ')})
        GROUP BY iwc.window_id, cc.slug, value
        ORDER BY iwc.window_id, cc.slug, count DESC
      `,
        windowIds
      );

      logger.info(
        { statsResultCount: statsResult.length },
        '[get_watcher] Got classification stats'
      );
      for (const row of statsResult as unknown as ClassificationStatsRow[]) {
        const windowId = ensureNumber(row.window_id);
        let windowStats = classificationStatsMap.get(windowId);
        if (!windowStats) {
          windowStats = {};
          classificationStatsMap.set(windowId, windowStats);
        }
        if (!windowStats[row.classifier_slug]) {
          windowStats[row.classifier_slug] = {};
        }
        windowStats[row.classifier_slug][row.value] = row.count;
      }
      logger.info(
        {
          mapSize: classificationStatsMap.size,
          mapKeys: Array.from(classificationStatsMap.keys()),
        },
        '[get_watcher] Classification stats map built'
      );
    } catch (error) {
      // Log but don't fail if classification stats query fails
      logger.warn({ error, windowIds }, '[get_watcher] Failed to fetch classification stats');
    }
  }

  // ============================================
  // Step 4.6: Await watcher details (query fired before classification stats)
  // ============================================

  let watcherRow: WatcherQueryRow | null = null;
  if (watcherQueryPromise) {
    const watcherQuery = await watcherQueryPromise;
    watcherRow = watcherQuery.length > 0 ? (watcherQuery[0] as unknown as WatcherQueryRow) : null;
  }

  // Resolve entityInfoForUrl / entitiesForTemplate from the entities array
  // that was folded into the watcher metadata query — only for the typical
  // case (no args.entity_id), which has been deferred from the start of the
  // function. When args.entity_id is set we already populated these above
  // from the dedicated entityCheck query.
  if (!args.entity_id && watcherRow?.entities && watcherRow.entities.length > 0) {
    const info = await buildEntityInfo(watcherRow.entities[0] as unknown as Record<string, unknown>);
    entityInfoForUrl = info.entityInfoForUrl;
    entitiesForTemplate = watcherRow.entities.map((e) => ({
      name: String(e.name),
      type: String(e.entity_type),
    }));
  }

  // ============================================
  // Step 5: Format results
  // ============================================

  // Format windows and include previous window data for trend calculation
  // Windows are sorted by window_start DESC, so "next" in array is "previous" chronologically
  const formattedWindows: WatcherWindow[] = typedWindows.map((w, index, arr) => {
    const previousWindow = arr[index + 1]; // Next in array = previous chronologically
    const windowIdNum = ensureNumber(w.window_id);
    const stats = classificationStatsMap.get(windowIdNum);
    const extractedData = parseJsonObject(w.extracted_data);
    const previousExtractedData = previousWindow
      ? parseJsonObject(previousWindow.extracted_data)
      : undefined;
    return {
      window_id: ensureNumber(w.window_id),
      watcher_id: w.watcher_id,
      watcher_name: w.watcher_name,
      granularity: w.granularity,
      window_start: w.window_start,
      window_end: w.window_end,
      is_rollup: w.is_rollup,
      content_analyzed: w.content_analyzed,
      extracted_data: extractedData,
      previous_extracted_data: previousExtractedData,
      classification_stats: stats,
      model_used: w.model_used ?? '',
      client_id: w.client_id ?? undefined,
      run_metadata: w.run_metadata ?? undefined,
      execution_time_ms: w.execution_time_ms ?? 0,
      created_at: w.created_at ?? w.window_end,
      version_id: w.version_id ?? undefined,
      json_template: w.json_template ?? undefined,
    };
  });

  // ============================================
  // Step 6: Fetch watcher metadata (for specific watcher queries)
  // ============================================

  let watcherMetadata: WatcherMetadata | undefined;
  let watcherCondensationPrompt: string | null = null;
  let watcherCondensationWindowCount: number | null = null;

  if (args.watcher_id && watcherRow) {
    const pinnedVersion = watcherRow.version;
    watcherCondensationPrompt = watcherRow.condensation_prompt;
    watcherCondensationWindowCount = watcherRow.condensation_window_count;

    // The selected version row (prompt/schema/template) was folded into the
    // watcher metadata query above via a `LEFT JOIN watcher_versions sv …`,
    // resolved against `args.template_version ?? i.version`. Reads from
    // watcherRow directly — no separate round-trip.
    //
    // available_versions list is opt-in (edit sheet) — still its own query.
    // Reads from the group root's chain (watcher_group_id) so non-root
    // assignments see the same version history as the root.
    const versionsQuery = args.include_versions
      ? await sql`
          SELECT
            wv.version,
            wv.name,
            wv.created_at,
            (wv.id = ${watcherRow.current_version_id}) as is_current
          FROM watcher_versions wv
          WHERE wv.watcher_id = (
            SELECT watcher_group_id FROM watchers WHERE id = ${args.watcher_id}
          )
          ORDER BY wv.version DESC
        `
      : ([] as unknown[]);

    const version: Record<string, unknown> | null = watcherRow.sel_version_id
      ? {
          version_id: watcherRow.sel_version_id,
          version: watcherRow.sel_version,
          name: watcherRow.sel_version_name,
          description: watcherRow.sel_version_description,
          prompt: watcherRow.sel_version_prompt,
          extraction_schema: watcherRow.sel_version_extraction_schema,
          version_sources: watcherRow.sel_version_version_sources,
          classifiers: watcherRow.sel_version_classifiers,
          json_template: watcherRow.sel_version_json_template,
        }
      : null;

    const availableVersions: WatcherVersionInfo[] | undefined = args.include_versions
      ? (
          versionsQuery as unknown as Array<{
            version: number;
            name: string;
            created_at: string;
            is_current: boolean;
          }>
        ).map((v) => ({
          version: v.version,
          name: v.name,
          created_at: v.created_at,
          is_current: v.is_current,
        }))
      : undefined;

    // Sources come from watcher row (or version if present)
    const watcherSources = parseWatcherSources(watcherRow.sources);

    watcherMetadata = {
      watcher_id: watcherRow.watcher_id,
      watcher_name: watcherRow.name || (version?.name as string) || 'Watcher',
      slug: watcherRow.slug || '',
      status: watcherRow.status as 'active' | 'archived',
      schedule: watcherRow.schedule,
      next_run_at: watcherRow.next_run_at,
      agent_id: watcherRow.agent_id,
      scheduler_client_id: watcherRow.scheduler_client_id,
      version: pinnedVersion,
      sources: watcherSources,
      prompt: version?.prompt as string | undefined,
      description: (version?.description as string) || undefined,
      extraction_schema: version?.extraction_schema as Record<string, unknown> | undefined,
      json_template: version?.json_template || undefined,
      rendered_prompt: version?.prompt
        ? renderPromptPreview(version.prompt as string, entitiesForTemplate)
        : undefined,
      ...(availableVersions !== undefined && { available_versions: availableVersions }),
      reaction_script: watcherRow.reaction_script || undefined,
      watcher_run:
        watcherRow.watcher_run_id && watcherRow.watcher_run_status
          ? {
              run_id: Number(watcherRow.watcher_run_id),
              status: watcherRow.watcher_run_status as
                | 'pending'
                | 'claimed'
                | 'running'
                | 'completed'
                | 'failed'
                | 'cancelled'
                | 'timeout',
              error_message: watcherRow.watcher_run_error ?? undefined,
              created_at: watcherRow.watcher_run_created_at,
              completed_at: watcherRow.watcher_run_completed_at,
            }
          : undefined,
    };
  }

  // ============================================
  // Step 6.5: Compute pending analysis info
  // ============================================
  // Count content NOT in any window for this watcher (using watcher_window_events)
  // Calculate next window bounds based on schedule
  // Generate processing instructions for client-driven watcher generation

  let pendingAnalysis: PendingAnalysis | undefined;

  if (args.watcher_id && watcherRow) {
    const watcherEntityIds = parseBigintArray(watcherRow.entity_ids);
    const watcherEntityId = watcherEntityIds[0] ?? 0;
    const timeGranularity = inferWatcherGranularityFromSchedule(watcherRow.schedule);

    // Identity scopes + latest window end were folded into the watcher
    // metadata query above. Read both off watcherRow — no extra round-trip.
    // Scopes drive the entity-link UNION (only emit branches for namespaces
    // the entity actually owns); latestEnd bounds the unprocessedCount scan
    // so the planner uses idx_events_entity_ids_occurred_at.
    const entityScopes: EntityIdentityScope[] = (watcherRow.entity_scopes ?? []).filter((s) =>
      (STANDARD_IDENTITY_NAMESPACES as readonly string[]).includes(s.namespace)
    );
    const latestEnd = watcherRow.latest_window_end;
    // Two entity-link fragments: one with `$1 = watcher_id` reserved (for
    // queries that join on the watcher's windows), one without (for queries
    // that only need the entity scope). Sharing one fragment and passing a
    // phantom `$1` fails the postgres.js parse step when the entity has zero
    // identity scopes (query has zero placeholders, bind has one).
    const entityLinkWatcherScoped = buildEntityLinkUnion({
      entityIdLiteral: watcherEntityId,
      scopes: entityScopes,
      baseParamIndex: 2,
    });
    const entityLinkOnly = buildEntityLinkUnion({
      entityIdLiteral: watcherEntityId,
      scopes: entityScopes,
      baseParamIndex: 1,
    });
    const entityScopeCondition = entityLinkWatcherScoped.sql;
    const entityScopeOnlyCondition = entityLinkOnly.sql;
    const entityLinkParams = entityLinkWatcherScoped.params;
    const entityLinkOnlyParams = entityLinkOnly.params;

    // Bound the entity-scoped scans by `f.occurred_at >= latestEnd` only when
    // the watcher has actually produced a window. Without the bound the
    // planner walks the entity's full event history; with it, the planner
    // uses `idx_events_entity_ids_occurred_at` for an indexed range scan.
    //
    // For fresh watchers (latestEnd === null), bound by 90 days ago. The
    // older "unbounded so the badge reflects the full backlog" path blows
    // the 10s frontend timeout on high-volume entities (e.g. 78K+ events
    // → 9.5s scan, then "Failed to load watcher"). 90 days matches the
    // per-month histogram's natural horizon, keeps the scan indexed, and
    // the badge is a notification — not a backlog audit.
    const FRESH_WATCHER_LOOKBACK_DAYS = 90;
    const effectiveBound =
      latestEnd ??
      new Date(Date.now() - FRESH_WATCHER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const occurredAtBound = `f.occurred_at >= $${2 + entityLinkParams.length}::timestamptz`;
    const occurredAtBoundNoWatcher = `f.occurred_at >= $${1 + entityLinkOnlyParams.length}::timestamptz`;
    const watcherScopedParams = [args.watcher_id, ...entityLinkParams, effectiveBound];
    const noWatcherParams = [...entityLinkOnlyParams, effectiveBound];

    const notInWindowClause = `NOT EXISTS (
        SELECT 1 FROM watcher_window_events iwc
        JOIN watcher_windows iw ON iw.id = iwc.window_id
        WHERE iwc.event_id = f.id AND iw.watcher_id = $1
      )`;

    // unprocessed_count drives the badge ("N pending analysis"). Cap the
    // scan at 1000 rows: the badge shows "1000+" semantics above that, and
    // the cap keeps the page query under the 10s frontend timeout even on
    // entities with 100K+ events in the lookback window. The 90-day bound
    // above lets the planner pick `idx_events_entity_ids_occurred_at`, but
    // on a high-volume entity that index range still has ~78K rows; the
    // LIMIT short-circuits row fetches once we've passed the cap.
    //
    // monthlyContent / monthlyLinked build the per-month histogram for
    // unprocessed_ranges, only used inside the (collapsed-by-default) summary
    // view. Off by default; the summary expand path sets include_pending_ranges
    // to true.
    const UNPROCESSED_COUNT_CAP = 1000;
    const unprocessedCountPromise = sql.unsafe(
      `SELECT CAST(COUNT(*) AS INTEGER) as count FROM (
        SELECT 1
        FROM current_event_records f
        WHERE ${entityScopeCondition}
          ${occurredAtBound ? `AND ${occurredAtBound}` : ''}
          AND ${notInWindowClause}
        LIMIT ${UNPROCESSED_COUNT_CAP}
      ) capped`,
      watcherScopedParams
    );

    const histogramPromise = args.include_pending_ranges
      ? Promise.all([
          sql.unsafe(
            `SELECT DATE_TRUNC('month', f.occurred_at) as month, COUNT(*) as total
              FROM current_event_records f
              WHERE ${entityScopeOnlyCondition}
                ${occurredAtBoundNoWatcher ? `AND ${occurredAtBoundNoWatcher}` : ''}
              GROUP BY DATE_TRUNC('month', f.occurred_at)
              ORDER BY month`,
            noWatcherParams
          ),
          sql.unsafe(
            `SELECT DATE_TRUNC('month', f.occurred_at) as month, COUNT(DISTINCT f.id) as linked
              FROM current_event_records f
              JOIN watcher_window_events iwc ON f.id = iwc.event_id
              JOIN watcher_windows iw ON iwc.window_id = iw.id
              WHERE ${entityScopeCondition}
                ${occurredAtBound ? `AND ${occurredAtBound}` : ''}
                AND iw.watcher_id = $1
              GROUP BY DATE_TRUNC('month', f.occurred_at)`,
            watcherScopedParams
          ),
        ])
      : Promise.resolve([[], []] as [unknown[], unknown[]]);

    const [unprocessedCountResult, [monthlyContentResult, monthlyLinkedResult]] = await Promise.all(
      [unprocessedCountPromise, histogramPromise]
    );

    const unprocessedCount = Number(unprocessedCountResult[0]?.count ?? 0);

    // Calculate next window bounds based on granularity using the
    // already-fetched latestEnd (no extra round-trip).
    let nextWindow: PendingAnalysis['next_window'] = null;

    if (unprocessedCount > 0) {
      const now = new Date();
      let windowStart: Date;
      let windowEnd: Date;

      if (latestEnd) {
        // Continue from where we left off.
        windowStart = new Date(latestEnd);
      } else {
        // No windows yet — find the earliest unprocessed event for this
        // entity. Unbounded by occurred_at: pi review (#481) flagged that
        // a 90-day default would silently strip pre-existing backlogs from
        // the next_window calculation when a user creates a watcher on top
        // of long-since-ingested data.
        const earliestResult = await sql.unsafe(
          `SELECT MIN(f.occurred_at) as earliest
            FROM current_event_records f
            WHERE ${entityScopeCondition}
              AND ${notInWindowClause}`,
          [args.watcher_id, ...entityLinkParams]
        );
        const earliest = earliestResult[0]?.earliest as string | null;
        windowStart = earliest ? new Date(earliest) : now;
      }

      // Calculate window end based on granularity
      windowEnd = addWatcherPeriod(windowStart, timeGranularity);

      // Don't go past now
      if (windowEnd > now) {
        windowEnd = now;
      }

      nextWindow = {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
        granularity: timeGranularity,
      };
    }

    const unprocessedRanges: import('../types/watchers').UnprocessedRange[] = [];
    if (args.include_pending_ranges) {
      const linkedByMonth = new Map<string, number>();
      for (const row of monthlyLinkedResult as Array<Record<string, unknown>>) {
        const monthKey = new Date(row.month as string).toISOString().slice(0, 7);
        linkedByMonth.set(monthKey, Number(row.linked));
      }

      for (const row of monthlyContentResult as Array<Record<string, unknown>>) {
        const monthDate = new Date(row.month as string);
        const monthKey = monthDate.toISOString().slice(0, 7);
        const total = Number(row.total);
        const linked = linkedByMonth.get(monthKey) || 0;
        const unprocessed = total - linked;

        const rangeStart = new Date(monthDate);
        const rangeEnd = new Date(monthDate);
        rangeEnd.setMonth(rangeEnd.getMonth() + 1);
        rangeEnd.setMilliseconds(-1);

        if (unprocessed > 0) {
          unprocessedRanges.push({
            month: monthKey,
            window_start: rangeStart.toISOString(),
            window_end: rangeEnd.toISOString(),
            total_content: total,
            processed_content: linked,
            unprocessed_content: unprocessed,
            status: linked === 0 ? 'unprocessed' : 'partial',
          });
        }
      }
    }

    // Generate structured next_action for MCP clients
    const nextAction = nextWindow
      ? {
          tool: 'read_knowledge',
          params: {
            watcher_id: args.watcher_id,
            since: nextWindow.start.split('T')[0],
            until: nextWindow.end.split('T')[0],
          },
          description:
            'Fetch content for analysis. Response includes window_token for complete_window action.',
        }
      : null;

    pendingAnalysis = {
      unprocessed_count: unprocessedCount,
      next_window: nextWindow,
      next_action: nextAction,
      unprocessed_ranges: unprocessedRanges.length > 0 ? unprocessedRanges : undefined,
    };

    if (unprocessedCount > 0) {
      logger.info(
        `[get_watcher] Found ${unprocessedCount} unprocessed content items for watcher ${args.watcher_id}`
      );
    }
  }

  // ============================================
  // Step 6.6: Compute condensation status
  // ============================================

  let condensationStatus: GetWatcherResult['condensation'] | undefined;

  if (args.watcher_id && watcherCondensationPrompt) {
    try {
      const requiredCount = Number(watcherCondensationWindowCount) || 4;
      const uncondensedResult = await queryUncondensedWindows(sql, args.watcher_id);
      const uncondensedCount = uncondensedResult.length;

      condensationStatus = {
        ready: uncondensedCount >= requiredCount,
        uncondensed_count: uncondensedCount,
        required_count: requiredCount,
      };

      if (uncondensedCount > 0) {
        condensationStatus.window_range = {
          start: uncondensedResult[0].window_start,
          end: uncondensedResult[uncondensedResult.length - 1].window_end,
        };
      }
    } catch (err) {
      logger.warn({ err }, '[get_watcher] Failed to compute condensation status');
    }
  }

  // ============================================
  // Step 7: Diagnostic warnings for the no-windows case
  // ============================================
  // Replaces the previous cold-path block (a watchers re-fetch + a
  // 5-table-join entity_context aggregate that ran ~20s/call in prod for
  // entities with any volume — measured via pg_stat_statements). Both
  // produced fields (`watcher_statuses`, `entity_context`) had zero UI
  // consumers; the only live output was the warnings, which we can derive
  // from data already in scope.

  const warnings: string[] = [];

  if (formattedWindows.length === 0 && watcherRow) {
    if (watcherRow.status === 'archived') {
      warnings.push(`Watcher "${watcherRow.name ?? args.watcher_id}" is archived.`);
    } else {
      warnings.push(`Watcher "${watcherRow.name ?? args.watcher_id}" has no windows yet.`);
    }
  }

  // ============================================
  // Step 8: Return results with diagnostic info
  // ============================================

  if (usedFallback && finalGranularity && actualGranularity) {
    warnings.push(
      `No ${finalGranularity} windows available yet. Showing ${actualGranularity} windows instead. Rollups are generated automatically as more data is collected.`
    );
  }

  // Detect gaps between consecutive windows (single-watcher queries only)
  let windowGaps: WindowGap[] | undefined;
  if (args.watcher_id && formattedWindows.length > 1) {
    const sorted = [...formattedWindows].sort(
      (a, b) => new Date(a.window_start).getTime() - new Date(b.window_start).getTime()
    );
    const gaps: WindowGap[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = new Date(sorted[i - 1].window_end).getTime();
      const currStart = new Date(sorted[i].window_start).getTime();
      if (currStart > prevEnd) {
        gaps.push({
          start: new Date(prevEnd).toISOString(),
          end: new Date(currStart).toISOString(),
        });
      }
    }
    if (gaps.length > 0) windowGaps = gaps;
  }

  const result: GetWatcherResult = {
    windows: formattedWindows,
    ...(watcherMetadata && { watcher: watcherMetadata }),
    ...(pendingAnalysis && { pending_analysis: pendingAnalysis }),
    ...(windowGaps && { gaps: windowGaps }),
    pagination: {
      page,
      page_size: pageSize,
      total: totalCount,
    },
    metadata: {
      query_type: args.watcher_id ? 'specific' : 'all_for_entity',
      date_range: {
        content_since: parsedSince || null,
        content_until: parsedUntil || null,
      },
      granularity_filter: finalGranularity || null,
      granularity_inferred: !args.granularity && !!inferredGranularity,
      granularity_actual: actualGranularity || null,
      granularity_fallback_used: usedFallback,
    },
    ...(condensationStatus && { condensation: condensationStatus }),
    ...(warnings.length > 0 && { warnings }),
    ...(entityInfoForUrl && { view_url: buildWatchersUrl(entityInfoForUrl, baseUrl) }),
  };

  return result;
}
