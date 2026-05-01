/**
 * Tool: manage_watchers
 *
 * Manage self-contained watcher definitions with client-driven execution.
 *
 * Actions:
 * - create: Create watcher with prompt/schema/sources directly
 * - update: Modify config (model, schedule, sources)
 * - create_version: Create a new version for a watcher (prompt/schema/sources)
 * - upgrade: Upgrade watcher to a specific version
 * - complete_window: Complete a window using window_token from read_knowledge
 * - delete: Remove watcher
 * - set_reaction_script: Attach automated TypeScript reaction
 * - get_versions: View version history for a watcher
 * - get_version_details: Get full config for a specific version
 * - get_component_reference: Get available components and data types documentation
 */

import { type Static, Type } from '@sinclair/typebox';
import Ajv from 'ajv';
import { createDbClientFromEnv, type DbClient, getDb, pgBigintArray } from '../../db/client';
import type { Env } from '../../index';
import { isLobuGatewayRunning } from '../../lobu/gateway';
import type { ComponentReferenceDocumentation } from '../../types/templates';
import type { WatcherSource } from '../../types/watchers';
import { entityLinkMatchSql } from '../../utils/content-search';
import { nextRunAt, validateSchedule } from '../../utils/cron';
import { type DataSourceContext, executeDataSources } from '../../utils/execute-data-sources';
import { recordChangeEvent } from '../../utils/insert-event';
import type { WindowTokenQueryParams } from '../../utils/jwt';
import { verifyWindowToken } from '../../utils/jwt';
import logger from '../../utils/logger';
import { requireReadAccess, requireWriteAccess } from '../../utils/organization-access';
import { resolveUsernames } from '../../utils/resolve-usernames';
import { computeStableKeys } from '../../utils/stable-keys';
import {
  buildWatchersUrl,
  type EntityInfo,
  getOrganizationSlug,
  getPublicWebUrl,
} from '../../utils/url-builder';
import { trackWatcherReaction } from '../../utils/watcher-reactions';
import {
  buildLatestWatcherRunJoinSql,
  getWatcherRunInfo,
  queueAndDispatchWatcherRun,
} from '../../watchers/automation';
import {
  createClassifiersForWatcher,
  enableClassifiersOnEntity,
  getFieldsToStrip,
  processWatcherClassifications,
  stripFields,
} from '../../watchers/classifier-extraction';
import { compileReactionScript, executeReaction } from '../../watchers/reaction-executor';
import { validateTemplate } from '../../watchers/renderer';
import { validateClassifierSourcePaths, validateExtractionSchema } from '../../watchers/validator';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';
import { requireExists } from './helpers/db-helpers';

// Initialize AJV for JSON Schema validation
// removeAdditional: true strips fields like 'embedding' that workers add but aren't in the schema
// This allows workers to add internal fields while still validating the core schema
const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: true });

/**
 * Batch count unanalyzed content for multiple watchers in a single query.
 * Returns a map of watcher_id -> count of content not yet in any window for that watcher.
 */
async function batchCountUnanalyzedContent(
  watcherIds: number[]
): Promise<Map<number, { pending: number; historical: number }>> {
  if (watcherIds.length === 0) {
    return new Map();
  }

  const sql = getDb();

  const placeholders = watcherIds.map((_, i) => `$${i + 1}`).join(', ');

  // The "total content" count joins current_event_records on the entity link
  // for every watcher in the result. On high-volume entities this scans
  // 100K+ rows per watcher and dominates list_watchers latency (8-12s on
  // prod for orgs with even a single Reddit-Digest-class watcher).
  //
  // Cap the per-watcher total at TOTAL_CAP rows. The badge derived from
  // `pending_count = total - analyzed` becomes "TOTAL_CAP+ - analyzed"
  // semantics above the cap; the only consumer is a list-row badge that
  // doesn't need exact counts above a threshold.
  const TOTAL_CAP = 1000;
  const result = await sql.unsafe(
    `
    WITH watcher_entities AS (
      SELECT i.id as watcher_id, unnest(i.entity_ids) as entity_id
      FROM watchers i
      WHERE i.id IN (${placeholders})
        AND array_length(i.entity_ids, 1) > 0
    ),
    analyzed_counts AS (
      SELECT
        ie.watcher_id,
        COUNT(DISTINCT iwc.event_id) as analyzed_count
      FROM (SELECT DISTINCT watcher_id FROM watcher_entities) ie
      LEFT JOIN watcher_windows iw ON iw.watcher_id = ie.watcher_id
      LEFT JOIN watcher_window_events iwc ON iwc.window_id = iw.id
      GROUP BY ie.watcher_id
    ),
    total_counts AS (
      SELECT
        wid AS watcher_id,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM watcher_entities ie
          JOIN current_event_records f ON ${entityLinkMatchSql('ie.entity_id::bigint', 'f')}
          WHERE ie.watcher_id = wid
          LIMIT ${TOTAL_CAP}
        ) capped) AS total_count
      FROM (SELECT DISTINCT watcher_id AS wid FROM watcher_entities) per_watcher
    )
    SELECT
      ac.watcher_id,
      CAST(GREATEST(COALESCE(tc.total_count, 0) - COALESCE(ac.analyzed_count, 0), 0) AS INTEGER) as pending_count,
      0 as historical_count
    FROM analyzed_counts ac
    LEFT JOIN total_counts tc ON tc.watcher_id = ac.watcher_id
    `,
    watcherIds
  );

  const counts = new Map<number, { pending: number; historical: number }>();
  for (const row of result) {
    counts.set(Number(row.watcher_id), {
      pending: (row.pending_count as number) ?? 0,
      historical: (row.historical_count as number) ?? 0,
    });
  }

  for (const id of watcherIds) {
    if (!counts.has(id)) {
      counts.set(id, { pending: 0, historical: 0 });
    }
  }

  return counts;
}

function summarizeResults(results: WatcherOperationResult[]) {
  const successful = results.filter((r) => r.success).length;
  return { total: results.length, successful, failed: results.length - successful };
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

function normalizeExtractedData(value: unknown): Record<string, unknown> {
  const parsedValue =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            throw new Error(
              'extracted_data must be a valid JSON object. Received an invalid JSON string.'
            );
          }
        })()
      : value;

  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    throw new Error(
      'extracted_data must be a JSON object matching the template extraction_schema.'
    );
  }

  return parsedValue as Record<string, unknown>;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0)
    )
  );
}

type NumericIdTable = 'watchers' | 'watcher_windows' | 'watcher_window_events';

const ALLOWED_NUMERIC_ID_TABLES = new Set<string>([
  'watchers',
  'watcher_windows',
  'watcher_window_events',
]);

async function getNextNumericId(sql: DbClient, table: NumericIdTable): Promise<number> {
  if (!ALLOWED_NUMERIC_ID_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const rows = await sql.unsafe<{ next_id: number }>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ${table}`
  );
  return Number(rows[0]?.next_id ?? 1);
}

// ============================================
// Content Query (inlined from watcher-content-query)
// ============================================

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

async function queryContentIds(sql: DbClient, params: ContentQueryParams): Promise<number[]> {
  const results = await executeDataSources(params.sources, buildContentQueryContext(params), sql, {
    wrapQuery: (q) => `SELECT id FROM (${q}) AS _cw_ids`,
  });

  const allIds: number[] = [];
  for (const rows of Object.values(results)) {
    for (const row of rows) {
      const id = (row as Record<string, unknown>).id;
      if (typeof id === 'number') allIds.push(id);
      else if (typeof id === 'string') {
        const parsed = Number.parseInt(id, 10);
        if (Number.isFinite(parsed)) allIds.push(parsed);
      }
    }
  }

  const { limit, offset } = params.query_params;
  const start = Number(offset) || 0;
  const end = start + (Number(limit) || allIds.length);
  return [...new Set(allIds)].slice(start, end);
}

// ============================================
// Typebox Schema (Flattened for MCP)
// ============================================

// Source definition — named SQL query
const SourceSchema = Type.Object({
  name: Type.String({ description: 'Source name (e.g., "content", "volume")' }),
  query: Type.String({
    description:
      'SQL SELECT query. If it references the events table, time window bounds are auto-applied.',
  }),
});

// Flattened schema for MCP compatibility (MCP doesn't support top-level unions)
export const ManageWatchersSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('create'),
      Type.Literal('update'),
      Type.Literal('create_version'),
      Type.Literal('upgrade'),
      Type.Literal('complete_window'),
      Type.Literal('trigger'),
      Type.Literal('delete'),
      Type.Literal('set_reaction_script'),
      Type.Literal('get_versions'),
      Type.Literal('get_version_details'),
      Type.Literal('get_component_reference'),
      Type.Literal('submit_feedback'),
      Type.Literal('get_feedback'),
      Type.Literal('create_from_version'),
    ],
    { description: 'Action to perform' }
  ),

  // Watcher identity
  watcher_id: Type.Optional(
    Type.String({
      description:
        '[update/upgrade/get_versions/get_version_details/set_reaction_script/trigger] Watcher ID (numeric string)',
    })
  ),
  watcher_ids: Type.Optional(
    Type.Array(Type.String(), {
      description: '[delete] Array of watcher IDs (numeric strings)',
    })
  ),

  // Fields for action="create"
  slug: Type.Optional(Type.String({ description: '[create] Unique watcher identifier' })),
  name: Type.Optional(Type.String({ description: '[create/create_version] Display name' })),
  description: Type.Optional(
    Type.String({ description: '[create/create_version] Watcher description' })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Entity ID. Required for create. Optional for list.',
    })
  ),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: '[create_from_version] Array of entity IDs to create individual watchers for.',
    })
  ),
  version_id: Type.Optional(
    Type.Number({
      description: '[create_from_version] Source version ID to use as template for new watchers.',
    })
  ),
  name_pattern: Type.Optional(
    Type.String({
      description:
        '[create_from_version] Name pattern for created watchers. Use {{entity_name}} for substitution. Default: "{version_name}: {entity_name}".',
    })
  ),

  // Watcher config fields (create/create_version/update)
  prompt: Type.Optional(
    Type.String({
      description:
        '[create/create_version] LLM prompt template (Handlebars). Variables: {{entities}}, {{content}}, {{sources.name}}, {{data.name}}, {{#each entities}}{{name}}{{/each}}.',
    })
  ),
  extraction_schema: Type.Optional(
    Type.Any({
      description: '[create/create_version] JSON Schema defining LLM output structure.',
    })
  ),
  sources: Type.Optional(
    Type.Array(SourceSchema, {
      description:
        '[create/create_version/update] Array of SQL data sources. Each source is { name, query }.',
    })
  ),
  json_template: Type.Optional(
    Type.Any({
      description: '[create/create_version] JSON template for React rendering.',
    })
  ),
  keying_config: Type.Optional(
    Type.Any({
      description: '[create/create_version] Config for stable key generation across windows.',
    })
  ),
  classifiers: Type.Optional(
    Type.Any({
      description: '[create/create_version] Classifier definitions for extraction.',
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        '[create/update/create_version] Cron expression for watcher schedule (e.g. "0 * * * *" for hourly, "0 9 * * *" for daily at 9am).',
    })
  ),
  agent_id: Type.Optional(
    Type.String({
      description: '[create/update] Agent ID that owns/executes this watcher.',
    })
  ),
  scheduler_client_id: Type.Optional(
    Type.String({
      description:
        '[create/update/create_version] Optional MCP client ID that should auto-run this watcher.',
    })
  ),
  model_config: Type.Optional(Type.Any({ description: '[create/update] AI model configuration' })),
  tags: Type.Optional(Type.Array(Type.String(), { description: '[create] Tags for filtering' })),

  // Version management
  version: Type.Optional(
    Type.Number({ description: '[upgrade/get_version_details] Version number' })
  ),
  target_version: Type.Optional(
    Type.Number({ description: '[upgrade] Version number to upgrade to' })
  ),
  change_notes: Type.Optional(
    Type.String({ description: '[create_version] Change notes for the new version' })
  ),
  set_as_current: Type.Optional(
    Type.Boolean({ description: '[create_version] Set as current version (default: true)' })
  ),
  condensation_prompt: Type.Optional(
    Type.String({
      description:
        '[create/create_version] Handlebars prompt for condensing windows into a rollup.',
    })
  ),
  condensation_window_count: Type.Optional(
    Type.Number({
      description:
        '[create/create_version] How many leaf windows to condense into one rollup. Default 4.',
      minimum: 2,
    })
  ),
  reactions_guidance: Type.Optional(
    Type.String({
      description:
        '[create/create_version] Guidance text for LLM agents on what reactions to take.',
    })
  ),

  // Fields for action="complete_window"
  extracted_data: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          '[complete_window] Required. LLM analysis results. Must match extraction_schema.',
      }
    )
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description: '[complete_window] Replace existing window for same period (default: false).',
    })
  ),
  window_token: Type.Optional(
    Type.String({
      description:
        '[complete_window] Required. JWT from read_knowledge(watcher_id, since, until). Contains signed window parameters.',
    })
  ),
  client_id: Type.Optional(
    Type.String({
      description:
        '[complete_window] Optional client identifier for execution provenance. Defaults to authenticated MCP client when available.',
    })
  ),
  model: Type.Optional(
    Type.String({
      description: '[complete_window] Optional model name used to produce the window result.',
    })
  ),
  run_metadata: Type.Optional(
    Type.Any({
      description:
        '[complete_window] Optional structured execution metadata for provenance (provider, session id, parameters, etc.).',
    })
  ),
  template_version_id: Type.Optional(
    Type.Number({
      description:
        "[complete_window] Pin to a specific watcher_versions.id. Workers receive this from the run dispatch payload (snapshotted from current_version_id at run-creation) and pass it back here so validation uses the same version that produced the extraction. Defaults to the run row's snapshot if available, else the watcher's current_version_id.",
    })
  ),

  // Fields for action="set_reaction_script"
  reaction_script: Type.Optional(
    Type.String({
      description:
        '[set_reaction_script] TypeScript source for automated reaction. Set to empty string to remove.',
    })
  ),

  // Fields for action="submit_feedback" / "get_feedback"
  window_id: Type.Optional(
    Type.Number({
      description:
        '[submit_feedback] Required. [get_feedback] Optional filter. Window ID to attach feedback to.',
    })
  ),
  corrections: Type.Optional(
    Type.Array(
      Type.Object({
        field_path: Type.String({
          description:
            'Dot/bracket path into extracted_data, e.g. "problems[1].severity" or "problems[2]" for an array item.',
        }),
        mutation: Type.Optional(
          Type.Union(
            [Type.Literal('set'), Type.Literal('remove'), Type.Literal('add')],
            {
              description:
                'Default "set". Use "remove" to drop an array item; "add" to append one.',
            }
          )
        ),
        value: Type.Optional(
          Type.Any({
            description:
              'New value for set/add. Omitted for remove. Any JSON type (string/number/object/array).',
          })
        ),
        note: Type.Optional(
          Type.String({ description: 'Optional per-field explanation.' })
        ),
      }),
      {
        description:
          '[submit_feedback] One entry per corrected field. Each row is stored independently so future corrections can supersede earlier ones per field.',
      }
    )
  ),
  limit: Type.Optional(
    Type.Number({
      description: '[get_feedback] Max feedback records to return (default: 50).',
    })
  ),
});

// ============================================
// Type Definitions
// ============================================

export type ManageWatchersArgs = Static<typeof ManageWatchersSchema>;

interface WatcherOperationResult {
  watcher_id: string;
  success: boolean;
  message: string;
  version?: number;
}

type ManageWatchersResult =
  | {
      action: 'create';
      watcher_id: string;
      version: number;
      status: string;
      sources?: Array<{ name: string; query: string }>;
      view_url?: string;
    }
  | { action: 'update'; watcher_id: string; updated_fields: string[] }
  | {
      action: 'create_version';
      watcher_id: string;
      version_id: string;
      version: number;
      previous_version: number;
    }
  | { action: 'upgrade'; watcher_id: string; version: number; previous_version: number }
  | {
      action: 'complete_window';
      watcher_id: string;
      window_id: number;
      window_start: string;
      window_end: string;
      content_linked: number;
    }
  | {
      action: 'trigger';
      watcher_id: string;
      run_id: number;
      status: string;
    }
  | {
      action: 'delete';
      results: WatcherOperationResult[];
      summary: { total: number; successful: number; failed: number };
    }
  | { action: 'set_reaction_script'; watcher_id: string; has_script: boolean; message: string }
  | { action: 'get_versions'; watcher_id: string; versions: any[] }
  | { action: 'get_version_details'; watcher_id: string; [key: string]: any }
  | { action: 'get_component_reference'; documentation: ComponentReferenceDocumentation }
  | {
      action: 'submit_feedback';
      watcher_id: string;
      window_id: number;
      feedback_ids: number[];
    }
  | {
      action: 'get_feedback';
      watcher_id: string;
      feedback: Array<{
        id: number;
        window_id: number;
        field_path: string;
        mutation: 'set' | 'remove' | 'add';
        corrected_value: unknown;
        note: string | null;
        created_by: string;
        created_at: string;
        window_start?: string;
        window_end?: string;
      }>;
    }
  | {
      action: 'create_from_version';
      created: Array<{ watcher_id: string; entity_id: number; name: string }>;
    };

export const ListWatchersSchema = Type.Object({
  watcher_id: Type.Optional(
    Type.String({
      description: 'Optional watcher ID (numeric string) to narrow to one watcher',
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Optional entity ID to list watchers attached to a specific entity',
    })
  ),
  status: Type.Optional(
    Type.String({
      description: 'Optional status filter. Use "active" or "archived". Omit to include all.',
    })
  ),
  include_details: Type.Optional(
    Type.Boolean({
      description: 'Include prompt, schema, and sources in response (default: false)',
    })
  ),
});

type ListWatchersArgs = Static<typeof ListWatchersSchema>;
type ListWatchersResult = { watchers: any[] };

// ============================================
// Main Function
// ============================================

export async function manageWatchers(
  args: ManageWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageWatchersResult> {
  const pgSql = createDbClientFromEnv(env);

  // Validate organization access based on action type
  if (args.action === 'create' && args.entity_id) {
    await requireWriteAccess(pgSql, args.entity_id, ctx);
  } else if (args.action === 'update' && args.watcher_id) {
    const entityId = await getWatcherEntityId(args.watcher_id);
    if (entityId) await requireWriteAccess(pgSql, entityId, ctx);
  } else if (args.action === 'trigger' && args.watcher_id) {
    const entityId = await getWatcherEntityId(args.watcher_id);
    if (entityId) await requireWriteAccess(pgSql, entityId, ctx);
  } else if (args.action === 'delete' && args.watcher_ids && args.watcher_ids.length > 0) {
    const entityIds = await getWatchersEntityIds(args.watcher_ids);
    for (const entityId of entityIds) {
      await requireWriteAccess(pgSql, entityId, ctx);
    }
  } else if (args.action === 'upgrade') {
    if (args.watcher_ids && args.watcher_ids.length > 0) {
      const entityIds = await getWatchersEntityIds(args.watcher_ids);
      for (const entityId of entityIds) {
        await requireWriteAccess(pgSql, entityId, ctx);
      }
    } else if (args.entity_id) {
      await requireWriteAccess(pgSql, args.entity_id, ctx);
    }
  } else if (args.action === 'complete_window' && args.entity_id) {
    await requireWriteAccess(pgSql, args.entity_id, ctx);
  } else if (args.action === 'submit_feedback' && args.watcher_id) {
    const entityId = await getWatcherEntityId(args.watcher_id);
    if (entityId) await requireWriteAccess(pgSql, entityId, ctx);
  } else if (args.action === 'get_feedback' && args.watcher_id) {
    const entityId = await getWatcherEntityId(args.watcher_id);
    if (entityId) await requireReadAccess(pgSql, entityId, ctx);
  } else if (args.action === 'create_from_version' && args.entity_ids) {
    for (const eid of args.entity_ids) {
      await requireWriteAccess(pgSql, eid, ctx);
    }
  }

  return routeAction<ManageWatchersResult>('manage_watchers', args.action, ctx, {
    create: () => handleCreate(args, env, ctx),
    update: () => handleUpdate(args, env),
    create_version: () => handleCreateVersion(args, env, ctx),
    upgrade: () => handleUpgrade(args, env),
    complete_window: () => handleCompleteWindow(args, env, ctx),
    trigger: () => handleTrigger(args, env),
    delete: () => handleDelete(args),
    set_reaction_script: () => handleSetReactionScript(args, env),
    get_versions: () => handleGetVersions(args),
    get_version_details: () => handleGetVersionDetails(args),
    get_component_reference: () => Promise.resolve(handleGetComponentReference()),
    submit_feedback: () => handleSubmitFeedback(args, ctx),
    get_feedback: () => handleGetFeedback(args, ctx),
    create_from_version: () => handleCreateFromVersion(args, env, ctx),
  });
}

export async function listWatchers(
  args: ListWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ListWatchersResult> {
  const pgSql = createDbClientFromEnv(env);
  if (args.entity_id) {
    await requireReadAccess(pgSql, args.entity_id, ctx);
  }
  return handleList(args, env, ctx);
}

/**
 * Helper: Get first entity_id from a single watcher (uses entity_ids bigint[])
 */
async function getWatcherEntityId(watcherId: string): Promise<number | null> {
  const sql = getDb();
  const result = await sql`
    SELECT entity_ids FROM watchers WHERE id = ${watcherId}
  `;
  if (result.length === 0) return null;
  const raw = result[0].entity_ids;
  const ids: number[] = Array.isArray(raw)
    ? raw.map(Number)
    : typeof raw === 'string'
      ? (raw as string).replace(/[{}]/g, '').split(',').filter(Boolean).map(Number)
      : [];
  return ids[0] ?? null;
}

/**
 * Helper: Get unique entity_ids from multiple watchers (uses entity_ids bigint[])
 */
async function getWatchersEntityIds(watcherIds: string[]): Promise<number[]> {
  if (watcherIds.length === 0) return [];
  const sql = getDb();
  const placeholders = watcherIds.map((_, idx) => `$${idx + 1}`).join(',');
  const result = await sql.unsafe(
    `SELECT DISTINCT unnest(entity_ids) as entity_id FROM watchers WHERE id IN (${placeholders})`,
    watcherIds
  );
  return result.map((r) => Number(r.entity_id));
}

// ============================================
// Helpers
// ============================================

function validateWatcherConfig(input: {
  prompt?: string;
  extraction_schema?: unknown;
  classifiers?: unknown[];
  sources?: Array<{ name: string; query: string }>;
}): string | null {
  if (!input.prompt || typeof input.prompt !== 'string') {
    return 'prompt is required and must be a string';
  }

  const templateValidation = validateTemplate(input.prompt);
  if (templateValidation) {
    return `prompt: ${templateValidation}`;
  }

  if (!input.extraction_schema || typeof input.extraction_schema !== 'object') {
    return 'extraction_schema is required and must be an object';
  }

  const schemaValidation = validateExtractionSchema(input.extraction_schema);
  if (schemaValidation) {
    return `extraction_schema: ${schemaValidation}`;
  }

  if (input.classifiers !== undefined) {
    if (!Array.isArray(input.classifiers)) {
      return 'classifiers must be an array';
    }
  }

  if (input.sources) {
    for (const source of input.sources) {
      const trimmed = source.query.trim().toUpperCase();
      if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
        return `source "${source.name}": query must be a SELECT statement (read-only)`;
      }
    }
  }

  return null;
}

function parseJsonInput<T>(value: unknown, label: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw new Error(
        `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return value as T;
}

function normalizeStoredJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toJsonParam(sql: DbClient, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return sql.json(value);
}

function toTextArrayParam(values: string[]): string {
  const arr = normalizeStringArray(values);
  if (arr.length === 0) return '{}';
  return (
    '{' + arr.map((v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}'
  );
}

async function getNextWatcherVersionId(sql: DbClient): Promise<number> {
  const rows = await sql.unsafe<{ next_id: number }>(
    'SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM watcher_versions'
  );
  return Number(rows[0]?.next_id ?? 1);
}

// ============================================
// Action Handlers
// ============================================

async function handleCreate(
  args: ManageWatchersArgs,
  _env: Env,
  ctx: ToolContext
): Promise<{
  action: 'create';
  watcher_id: string;
  version: number;
  status: string;
  sources?: Array<{ name: string; query: string }>;
  view_url?: string;
}> {
  const sql = getDb();

  // Require slug + prompt + extraction_schema for create
  if (!args.slug) {
    throw new Error('slug is required for create action');
  }
  if (!args.prompt) {
    throw new Error('prompt is required for create action');
  }
  if (!args.extraction_schema) {
    throw new Error('extraction_schema is required for create action');
  }

  // Require entity_id
  if (!args.entity_id) {
    throw new Error('entity_id is required');
  }

  const entityId = args.entity_id;

  // Parse JSON inputs
  const extractionSchema = parseJsonInput<Record<string, unknown>>(
    args.extraction_schema,
    'extraction_schema'
  );
  const jsonTemplate = parseJsonInput<unknown>(args.json_template, 'json_template');
  const keyingConfig = parseJsonInput<Record<string, unknown>>(args.keying_config, 'keying_config');
  const classifiers = parseJsonInput<unknown[]>(args.classifiers, 'classifiers');

  // Build sources array - use provided sources or create default
  const sources: Array<{ name: string; query: string }> =
    args.sources && args.sources.length > 0
      ? args.sources
      : [{ name: 'content', query: 'SELECT * FROM events ORDER BY occurred_at DESC' }];

  // Validate watcher config
  const validation = validateWatcherConfig({
    prompt: args.prompt,
    extraction_schema: extractionSchema,
    classifiers,
    sources,
  });
  if (validation) {
    throw new Error(`Watcher validation failed: ${validation}`);
  }

  if (classifiers && extractionSchema) {
    const classifierValidation = validateClassifierSourcePaths(
      classifiers as Array<{ slug: string; source_path?: string }>,
      extractionSchema
    );
    if (classifierValidation) {
      throw new Error(`Classifier-schema compatibility error: ${classifierValidation}`);
    }
  }

  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      throw new Error(scheduleError);
    }
  }

  interface EntityRow {
    entity_type: string;
    parent_id: number | null;
    slug: string;
    organization_id: string | null;
    parent_slug: string | null;
    parent_entity_type: string | null;
  }
  let entityRow: EntityRow | null = null;
  let organizationId: string | null = ctx.organizationId ?? null;
  let organizationSlug: string | null = null;

  const entityResult = await sql`
    SELECT
      e.id, et.slug AS entity_type, e.parent_id, e.slug, e.organization_id,
      parent.slug as parent_slug, pet.slug as parent_entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities parent ON e.parent_id = parent.id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    WHERE e.id = ${entityId}
  `;
  if (entityResult.length === 0) {
    throw new Error(`Entity with ID ${entityId} not found`);
  }
  entityRow = entityResult[0] as EntityRow;
  organizationId = entityRow.organization_id;
  organizationSlug = await getOrganizationSlug(organizationId);

  // Check slug uniqueness within org
  const existingSlug = await sql`
    SELECT id FROM watchers
    WHERE organization_id = ${organizationId} AND slug = ${args.slug}
    LIMIT 1
  `;
  if (existingSlug.length > 0) {
    throw new Error(`Watcher with slug '${args.slug}' already exists in this organization`);
  }

  // Validate schedule if provided
  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      return { error: scheduleError } as any;
    }
  }

  const watcherId = await getNextNumericId(sql, 'watchers');
  const versionId = await getNextWatcherVersionId(sql);
  const createdBy = ctx.userId ?? 'system';

  await sql.begin(async (tx) => {
    const entityIdsArray = entityId ? [entityId] : [];

    const nextRunAtVal = args.schedule ? nextRunAt(args.schedule) : null;

    // 1. Create watcher row
    await tx`
      INSERT INTO watchers (
        id, name, slug, organization_id, entity_ids,
        schedule, next_run_at, agent_id, scheduler_client_id, model_config, sources, version,
        current_version_id, tags, status, created_by, created_at, updated_at,
        watcher_group_id
      ) VALUES (
        ${watcherId}, ${args.name ?? args.slug}, ${args.slug}, ${organizationId},
        ${`{${entityIdsArray.join(',')}}`}::bigint[],
        ${args.schedule ?? null}, ${nextRunAtVal},
        ${args.agent_id ?? null}, ${args.scheduler_client_id ?? null},
        ${sql.json(args.model_config || {})}, ${sql.json(sources)},
        1, NULL, ${toTextArrayParam(args.tags || [])}::text[],
        'active', ${createdBy}, NOW(), NOW(),
        ${watcherId}
      )
    `;

    // 2. Create watcher_versions row (v1)
    await tx`
      INSERT INTO watcher_versions (
        id, watcher_id, version, name, description,
        prompt, extraction_schema, version_sources,
        json_template, keying_config, classifiers,
        condensation_prompt, condensation_window_count,
        reactions_guidance, change_notes, created_by, created_at
      ) VALUES (
        ${versionId}, ${watcherId}, 1, ${args.name ?? args.slug}, ${args.description ?? null},
        ${args.prompt}, ${toJsonParam(tx, extractionSchema)}, ${toJsonParam(tx, sources)},
        ${toJsonParam(tx, jsonTemplate)}, ${toJsonParam(tx, keyingConfig)}, ${toJsonParam(tx, classifiers)},
        ${args.condensation_prompt ?? null}, ${args.condensation_window_count ?? null},
        ${args.reactions_guidance ?? null}, ${'Initial version'}, ${createdBy}, NOW()
      )
    `;

    // 3. Point watcher to the newly created current version
    await tx`
      UPDATE watchers
      SET current_version_id = ${versionId}
      WHERE id = ${watcherId}
    `;

    // 4. Auto-create classifiers (entity-level only)
    if (entityId && classifiers && Array.isArray(classifiers) && classifiers.length > 0) {
      if (!ctx.userId) {
        throw new Error('Authenticated user is required to create watcher classifiers');
      }

      await createClassifiersForWatcher(tx, watcherId as number, entityId, classifiers as any[], {
        createdBy: ctx.userId,
        organizationId: ctx.organizationId,
      });

      const slugs = (classifiers as any[]).map((d: any) => d.slug);
      await enableClassifiersOnEntity(tx, entityId, slugs);
    }
  });

  // Build view URL
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  let viewUrl: string | undefined;

  if (entityRow !== null && organizationSlug) {
    const er = entityRow;
    const entityInfo: EntityInfo = {
      ownerSlug: organizationSlug,
      entityType: er.entity_type,
      slug: er.slug,
      parentType: er.parent_entity_type ?? null,
      parentSlug: er.parent_slug ?? null,
    };
    viewUrl = buildWatchersUrl(entityInfo, baseUrl);
  }

  logger.info(`[manage_watchers] Created watcher ${watcherId} with slug '${args.slug}'`);

  return {
    action: 'create',
    watcher_id: String(watcherId),
    version: 1,
    status: 'active',
    sources,
    view_url: viewUrl,
  };
}

async function handleCreateFromVersion(
  args: ManageWatchersArgs,
  _env: Env,
  ctx: ToolContext
): Promise<{
  action: 'create_from_version';
  created: Array<{ watcher_id: string; entity_id: number; name: string }>;
}> {
  const sql = getDb();

  if (!args.version_id) throw new Error('version_id is required for create_from_version');
  if (!args.entity_ids || args.entity_ids.length === 0) {
    throw new Error('entity_ids is required for create_from_version');
  }

  // Fetch the source version + the source watcher's reaction script.
  // Reaction script lives on the watchers row, not on watcher_versions, so
  // it has to be copied explicitly when assigning the template to a new
  // entity. Without this copy the new assignment would have no reactions.
  const versionRows = await sql`
    SELECT wv.*, w.organization_id, w.schedule, w.sources, w.agent_id, w.scheduler_client_id,
           w.model_config, w.tags, w.watcher_group_id,
           w.reaction_script, w.reaction_script_compiled
    FROM watcher_versions wv
    JOIN watchers w ON w.id = wv.watcher_id
    WHERE wv.id = ${args.version_id}
    LIMIT 1
  `;
  if (versionRows.length === 0) throw new Error(`Version ${args.version_id} not found`);
  const version = versionRows[0];
  const organizationId = version.organization_id as string;

  // Fetch entity names for name pattern substitution
  const entityRows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${`{${args.entity_ids.join(',')}}`}::bigint[])
  `;
  const entityMap = new Map(entityRows.map((e: any) => [Number(e.id), e]));

  const createdBy = ctx.userId ?? 'system';
  const created: Array<{ watcher_id: string; entity_id: number; name: string }> = [];

  for (const entityId of args.entity_ids) {
    const entity = entityMap.get(entityId);
    if (!entity) throw new Error(`Entity ${entityId} not found`);

    const namePattern = args.name_pattern ?? `${version.name}: {{entity_name}}`;
    const watcherName = namePattern.replace(/\{\{entity_name\}\}/g, entity.name as string);
    const watcherSlug = `${version.name}-${entity.slug}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const watcherId = await getNextNumericId(sql, 'watchers');
    const sources = version.version_sources ?? version.sources ?? [];
    // The new assignment shares the source's existing watcher_versions row
    // rather than getting its own duplicate copy. version_id (the arg) is
    // the row in watcher_versions we're cloning from; that becomes the
    // assignment's current_version_id directly. The version row itself is
    // owned by the group root (watcher_group_id), so all assignments in
    // the group point at the same chain.
    const sharedVersionId = Number(args.version_id);
    const groupId = (version.watcher_group_id ?? version.watcher_id) as number;

    await sql`
      INSERT INTO watchers (
        id, name, slug, organization_id, entity_ids,
        schedule, next_run_at, agent_id, scheduler_client_id, model_config, sources, version,
        current_version_id, tags, status, created_by, created_at, updated_at,
        watcher_group_id, source_watcher_id,
        reaction_script, reaction_script_compiled
      ) VALUES (
        ${watcherId}, ${watcherName}, ${watcherSlug}, ${organizationId},
        ${`{${entityId}}`}::bigint[],
        ${version.schedule ?? null}, ${version.schedule ? nextRunAt(version.schedule as string) : null},
        ${version.agent_id ?? null}, ${version.scheduler_client_id ?? null},
        ${toJsonParam(sql, version.model_config)}, ${toJsonParam(sql, sources)},
        ${(version.version as number) ?? 1}, ${sharedVersionId}, ${toTextArrayParam((version.tags as string[]) || [])}::text[],
        'active', ${createdBy}, NOW(), NOW(),
        ${groupId}, ${version.watcher_id},
        ${(version.reaction_script as string | null) ?? null},
        ${(version.reaction_script_compiled as string | null) ?? null}
      )
    `;

    created.push({ watcher_id: String(watcherId), entity_id: entityId, name: watcherName });
  }

  return { action: 'create_from_version', created };
}

async function handleUpdate(
  args: ManageWatchersArgs,
  _env: Env
): Promise<{ action: 'update'; watcher_id: string; updated_fields: string[] }> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for update action');
  }

  await requireExists(sql, 'watchers', args.watcher_id, 'Watcher');

  // Validate schedule if provided
  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      return { error: scheduleError } as any;
    }
  }

  const updatedFields: string[] = [];
  if (args.model_config !== undefined) updatedFields.push('model_config');
  if (args.schedule !== undefined) updatedFields.push('schedule');
  if (args.agent_id !== undefined) updatedFields.push('agent_id');
  if (args.scheduler_client_id !== undefined) updatedFields.push('scheduler_client_id');
  if (args.tags !== undefined) updatedFields.push('tags');

  if (updatedFields.length === 0) {
    return {
      action: 'update',
      watcher_id: args.watcher_id,
      updated_fields: [],
    };
  }

  const scheduleValue = args.schedule || null;
  const nextRunAtVal = scheduleValue ? nextRunAt(scheduleValue) : null;

  await sql`
    UPDATE watchers SET
      updated_at = NOW(),
      model_config = CASE WHEN ${args.model_config !== undefined} THEN ${sql.json(args.model_config ?? {})} ELSE model_config END,
      schedule = CASE WHEN ${args.schedule !== undefined} THEN ${scheduleValue} ELSE schedule END,
      next_run_at = CASE WHEN ${args.schedule !== undefined} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END,
      agent_id = CASE WHEN ${args.agent_id !== undefined} THEN ${args.agent_id ?? null} ELSE agent_id END,
      scheduler_client_id = CASE WHEN ${args.scheduler_client_id !== undefined} THEN ${args.scheduler_client_id ?? null} ELSE scheduler_client_id END,
      tags = CASE WHEN ${args.tags !== undefined} THEN ${toTextArrayParam(args.tags || [])}::text[] ELSE tags END
    WHERE id = ${args.watcher_id}
  `;

  logger.info(`[manage_watchers] Updated watcher ${args.watcher_id}: ${updatedFields.join(', ')}`);

  return {
    action: 'update',
    watcher_id: args.watcher_id,
    updated_fields: updatedFields,
  };
}

async function handleUpgrade(
  args: ManageWatchersArgs,
  _env: Env
): Promise<{
  action: 'upgrade';
  watcher_id: string;
  version: number;
  previous_version: number;
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for upgrade action');
  }
  if (args.target_version === undefined) {
    throw new Error('target_version is required for upgrade action');
  }

  // Get current watcher version
  const watcherRows = await sql`
    SELECT i.id, i.version, i.current_version_id
    FROM watchers i WHERE i.id = ${args.watcher_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Watcher ${args.watcher_id} not found`);
  }
  const previousVersion = Number(watcherRows[0].version);

  // Find target version
  const versionRows = await sql`
    SELECT id, version, version_sources
    FROM watcher_versions
    WHERE watcher_id = ${args.watcher_id} AND version = ${args.target_version}
    LIMIT 1
  `;
  if (versionRows.length === 0) {
    throw new Error(`Version ${args.target_version} not found for watcher ${args.watcher_id}`);
  }

  const newVersionId = versionRows[0].id;
  const versionSources = parseJson(versionRows[0].version_sources);

  // Update watcher to point to the new version
  await sql`
    UPDATE watchers
    SET
      current_version_id = ${newVersionId},
      version = ${args.target_version},
      sources = ${sql.json(versionSources || [])},
      updated_at = NOW()
    WHERE id = ${args.watcher_id}
  `;

  return {
    action: 'upgrade',
    watcher_id: args.watcher_id,
    version: args.target_version,
    previous_version: previousVersion,
  };
}

async function handleCompleteWindow(
  args: ManageWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<{
  action: 'complete_window';
  watcher_id: string;
  window_id: number;
  window_start: string;
  window_end: string;
  content_linked: number;
  is_rollup?: boolean;
  depth?: number;
  source_window_ids?: number[];
  reaction_status: 'success' | 'failed' | 'skipped';
  reaction_error?: string;
}> {
  const sql = getDb();
  const provenanceClientId = args.client_id ?? ctx.clientId ?? null;
  const provenanceModel =
    typeof args.model === 'string' && args.model.trim() ? args.model : 'external-client';
  const provenanceMetadata: Record<string, unknown> =
    args.run_metadata && typeof args.run_metadata === 'object' && !Array.isArray(args.run_metadata)
      ? (args.run_metadata as Record<string, unknown>)
      : {};
  const watcherRunIdRaw = provenanceMetadata.watcher_run_id;
  const watcherRunId =
    watcherRunIdRaw !== undefined && watcherRunIdRaw !== null && Number.isFinite(Number(watcherRunIdRaw))
      ? Number(watcherRunIdRaw)
      : null;

  // ============================================
  // STEP 1: Validate inputs (no DB calls)
  // ============================================
  if (!args.window_token) {
    throw new Error(
      'window_token is required for complete_window action. ' +
        'Get this token from read_knowledge({ watcher_id: ... }) response.'
    );
  }
  if (!args.extracted_data) {
    throw new Error(
      'extracted_data is required for complete_window action. ' +
        'This should contain the LLM analysis results (e.g., { sentiment: "positive", themes: [...] }).'
    );
  }
  const extractedData = normalizeExtractedData(args.extracted_data);

  // Verify and decode JWT window token (in-memory)
  let tokenPayload: {
    watcher_id: number;
    window_start: string;
    window_end: string;
    granularity: string;
    sources: Array<{ name: string; query: string }>;
    window_id?: number;
    query_params: {
      limit: number;
      offset: number;
      sort_by: 'date' | 'score';
      sort_order: 'asc' | 'desc';
    };
    content_count: number;
    iat: number;
  };

  try {
    tokenPayload = await verifyWindowToken(args.window_token, env);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid window_token: ${errorMsg}. ` +
        'The token may have expired or been tampered with. ' +
        'Get a fresh token from read_knowledge({ watcher_id: ... }).'
    );
  }

  const {
    watcher_id: watcherId,
    window_start,
    window_end,
    granularity,
    sources,
    window_id: tokenWindowId,
    query_params,
    content_count: tokenContentCount,
    iat: tokenIssuedAt,
    is_rollup: tokenIsRollup,
    source_window_ids: tokenSourceWindowIds,
    depth: tokenDepth,
  } = tokenPayload as typeof tokenPayload & {
    is_rollup?: boolean;
    source_window_ids?: number[];
    depth?: number;
  };

  const MAX_ROLLUP_DEPTH = 3;
  if (tokenIsRollup && tokenDepth != null && tokenDepth > MAX_ROLLUP_DEPTH) {
    throw new Error(`Rollup depth ${tokenDepth} exceeds maximum of ${MAX_ROLLUP_DEPTH}`);
  }

  // ============================================
  // STEP 2: Combined query - watcher + classifiers + template schema
  // ============================================
  // Resolve the version this run was started against. The agent extracted
  // data using that version's prompt/schema; we MUST validate against the
  // same version even if the group has been edited mid-run.
  //
  // Resolution order:
  //   1. explicit args.template_version_id (the agent passes this back)
  //   2. runs.approved_input.version_id (snapshotted at run-creation)
  //   3. watchers.current_version_id (fallback for callers outside a run)
  //
  // The run lookup is scoped by watcher_id so a wrong/stale watcher_run_id
  // can't read another watcher's snapshot.
  let snapshotVersionId: number | null =
    typeof args.template_version_id === 'number' ? args.template_version_id : null;
  if (snapshotVersionId == null && watcherRunId != null) {
    const runRows = await sql`
      SELECT (approved_input->>'version_id')::bigint AS version_id
      FROM runs
      WHERE id = ${watcherRunId} AND watcher_id = ${watcherId}
      LIMIT 1
    `;
    if (runRows.length > 0 && runRows[0].version_id != null) {
      snapshotVersionId = Number(runRows[0].version_id);
    }
  }

  // The version row must belong to this watcher's group — prevents pinning
  // to another group's version via a forged template_version_id arg.
  const watcherRows = await sql`
    SELECT
      i.id,
      i.schedule,
      i.entity_ids,
      i.organization_id,
      wv.id as version_id,
      wv.prompt as prompt,
      wv.extraction_schema as extraction_schema,
      wv.version_sources as version_sources,
      wv.classifiers as classifiers,
      wv.keying_config
    FROM watchers i
    LEFT JOIN watcher_versions wv
      ON wv.id = COALESCE(${snapshotVersionId}::bigint, i.current_version_id)
     AND wv.watcher_id = i.watcher_group_id
    WHERE i.id = ${watcherId}
    LIMIT 1
  `;

  if (watcherRows.length === 0) {
    throw new Error(
      `Watcher ${watcherId} not found. ` +
        'It may have been deleted. Use list_watchers to see available watchers.'
    );
  }

  // Fetch classifiers separately
  const classifierRows = await sql`
    SELECT
      cc.id,
      cc.slug,
      ccv.id as version_id,
      ccv.extraction_config
    FROM event_classifiers cc
    JOIN event_classifier_versions ccv ON cc.id = ccv.classifier_id AND ccv.is_current = true
    WHERE cc.watcher_id = ${watcherId}
      AND ccv.extraction_config IS NOT NULL
  `;

  const timeGranularity = granularity || 'weekly';
  const classifiers = classifierRows.map((r) => ({
    id: r.id as number,
    slug: r.slug as string,
    version_id: r.version_id as number,
    extraction_config: r.extraction_config as any,
  }));

  const resolvedVersionId =
    watcherRows[0].version_id != null ? Number(watcherRows[0].version_id) : null;
  const templateData = {
    prompt: watcherRows[0].prompt ?? undefined,
    extraction_schema: parseJson(watcherRows[0].extraction_schema) ?? undefined,
    data: parseJson(watcherRows[0].version_sources) ?? undefined,
    classifiers: parseJson(watcherRows[0].classifiers) ?? undefined,
  } as Record<string, any>;
  const keyingConfig = parseJson(watcherRows[0].keying_config) as {
    entity_path: string;
    key_fields: string[];
    key_output_field: string;
  } | null;

  // ============================================
  // STEP 2.5: Validate extracted_data against template's extraction_schema
  // ============================================
  if (templateData?.extraction_schema) {
    const extractionSchema = templateData.extraction_schema;
    const validate = ajv.compile(extractionSchema);
    // Validate a deep copy since removeAdditional:true mutates the data
    // This allows workers to include internal fields like 'embedding' that aren't in the schema
    const dataCopy = structuredClone(extractedData);
    const isValid = validate(dataCopy);

    if (!isValid) {
      const errors = validate.errors || [];
      const errorMessages = errors.map((e) => {
        const path = e.instancePath || '(root)';
        return `  - ${path}: ${e.message}`;
      });

      throw new Error(
        `extracted_data does not match template's extraction_schema.\n\n` +
          `Validation errors:\n${errorMessages.join('\n')}\n\n` +
          'Expected schema requires:\n' +
          `  - Required fields: ${JSON.stringify(extractionSchema.required || [])}\n` +
          `  - Top-level properties: ${Object.keys(extractionSchema.properties || {}).join(', ')}\n\n` +
          `Received top-level keys: ${Object.keys(extractedData).join(', ')}\n\n` +
          'Please ensure your LLM output matches the template schema exactly.'
      );
    }

    logger.info('[complete_window] extracted_data validated against template schema successfully');
  }

  // ============================================
  // STEP 2.6: Compute stable entity keys if template has keying_config
  // ============================================
  if (keyingConfig) {
    computeStableKeys(extractedData, keyingConfig);
    logger.info(
      `[complete_window] Computed stable keys for entities at path "${keyingConfig.entity_path}"`
    );
  }

  // ROLLUP PATH: If this is a condensation rollup, skip content linking
  if (tokenIsRollup && tokenSourceWindowIds && tokenSourceWindowIds.length > 0) {
    const depth = tokenDepth ?? 1;

    const newWindowId = await getNextNumericId(sql, 'watcher_windows');
    const sourceIds = tokenSourceWindowIds.map(Number);
    await sql`
      INSERT INTO watcher_windows (
        id, watcher_id, version_id, window_start, window_end, granularity,
        extracted_data, content_analyzed, model_used, client_id, run_metadata,
        is_rollup, depth, source_window_ids, run_id, created_at
      ) VALUES (
        ${newWindowId}, ${watcherId}, ${resolvedVersionId}, ${window_start}, ${window_end}, ${granularity || timeGranularity},
        ${sql.json(extractedData)}, 0, ${provenanceModel}, ${provenanceClientId}, ${sql.json(provenanceMetadata)},
        true, ${depth}, ${sourceIds}, ${watcherRunId}, NOW()
      )
    `;

    logger.info(
      `[complete_window] Created rollup window ${newWindowId} for watcher ${watcherId} ` +
        `(depth=${depth}, sources=${tokenSourceWindowIds.join(',')})`
    );

    return {
      action: 'complete_window',
      watcher_id: String(watcherId),
      window_id: newWindowId,
      window_start,
      window_end,
      content_linked: 0,
      is_rollup: true,
      depth,
      source_window_ids: tokenSourceWindowIds,
      reaction_status: 'skipped' as const,
    };
  }

  // ============================================
  // STEP 3: Query content IDs (batch query)
  // ============================================
  const entityIds = watcherRows[0].entity_ids as number[] | null;
  const parsedEntityIds =
    Array.isArray(entityIds) && entityIds.length > 0 ? entityIds.map(Number) : undefined;
  const allContentIds = await queryContentIds(sql, {
    sources,
    window_start,
    window_end,
    query_params,
    organizationId: watcherRows[0].organization_id as string,
    entityIds: parsedEntityIds,
  });
  const batchContentIds = [...new Set(allContentIds)];

  // Log staleness detection
  const tokenAge = Math.floor(Date.now() / 1000) - tokenIssuedAt;
  if (batchContentIds.length !== tokenContentCount) {
    logger.warn(
      `[complete_window] Content count mismatch: token had ${tokenContentCount} items, query returned ${batchContentIds.length}. Token age: ${tokenAge}s`
    );
  } else {
    logger.info(
      `[complete_window] Token valid: ${batchContentIds.length} content items, token age: ${tokenAge}s`
    );
  }

  // ============================================
  // STEP 4: Deduplicate content (batch query)
  // ============================================
  let alreadyAnalyzed: any[] = [];
  if (batchContentIds.length > 0) {
    alreadyAnalyzed = await sql.unsafe(
      `SELECT DISTINCT iwc.event_id
       FROM watcher_window_events iwc
       JOIN watcher_windows iw ON iw.id = iwc.window_id
       WHERE iw.watcher_id = $1
         AND iwc.event_id = ANY($2::bigint[])`,
      [watcherId, pgBigintArray(batchContentIds)]
    );
  }
  const alreadyAnalyzedIds = new Set(alreadyAnalyzed.map((r) => Number(r.event_id)));
  const uniqueContentIds = batchContentIds.filter((id) => !alreadyAnalyzedIds.has(id));

  const skippedCount = batchContentIds.length - uniqueContentIds.length;
  if (skippedCount > 0) {
    logger.info(
      `[complete_window] Skipped ${skippedCount} content items already analyzed by watcher ${watcherId}`
    );
  }

  // ============================================
  // STEP 5: Process extracted_data BEFORE any writes (in-memory)
  // ============================================
  const fieldsToStrip = getFieldsToStrip(classifiers);
  const cleanedExtractedData = stripFields(extractedData, Array.from(fieldsToStrip));

  // ============================================
  // STEP 6: Wrap all DB operations in a transaction
  // If classification processing fails (e.g., embeddings service unavailable),
  // the entire operation rolls back - no corrupted data is saved.
  //
  // Transaction for data writes.
  // ============================================
  const result = await sql.begin(async (tx) => {
    // ============================================
    // STEP 7: Get or create window with FINAL values
    //
    // Empty-content replay is idempotent: if a zero-content window already
    // exists for this period (a prior run consumed all candidates already),
    // refresh provenance instead of throwing "Window already exists". This
    // keeps the agent loop from retrying the same period forever (OWLETTO-Q)
    // without needing a separate no-op code path.
    // ============================================
    let windowId!: number;
    let windowCreated = false;

    if (tokenWindowId) {
      // Legacy flow: window_id in token, verify and update it
      const windowResult = await tx`
        UPDATE watcher_windows
        SET
          extracted_data = ${sql.json(cleanedExtractedData)},
          content_analyzed = ${uniqueContentIds.length},
          model_used = ${provenanceModel},
          client_id = ${provenanceClientId},
          run_metadata = ${sql.json(provenanceMetadata)},
          run_id = COALESCE(${watcherRunId}, run_id),
          created_at = COALESCE(created_at, NOW())
        WHERE id = ${tokenWindowId} AND watcher_id = ${watcherId}
        RETURNING id
      `;
      if (windowResult.length === 0) {
        throw new Error(
          `Window ${tokenWindowId} not found for watcher ${watcherId}. ` +
            'The window may have been deleted. Get a fresh token from read_knowledge({ watcher_id: ... }).'
        );
      }
      windowId = tokenWindowId;
    } else {
      // New flow: check for existing window first
      const existingWindow = await tx`
        SELECT id, content_analyzed FROM watcher_windows
        WHERE watcher_id = ${watcherId}
          AND window_start = ${window_start}
          AND window_end = ${window_end}
          AND granularity = ${timeGranularity}
        LIMIT 1
      `;

      let reuseExistingWindow = false;
      if (existingWindow.length > 0) {
        if (args.replace_existing) {
          // Delete existing window and its content links
          windowId = existingWindow[0].id as number;
          await tx`DELETE FROM watcher_window_events WHERE window_id = ${windowId}`;
          await tx`DELETE FROM watcher_windows WHERE id = ${windowId}`;
          logger.info(
            `[complete_window] Deleted existing window ${windowId} (replace_existing=true)`
          );
        } else if (watcherRunId != null || uniqueContentIds.length === 0) {
          // Idempotent replay: reuse the existing window so retries/manual
          // runs can still mark their run completed. Only refresh analysis
          // payload if the existing row was itself a no-op write — never
          // overwrite a successful completion's extracted data.
          windowId = existingWindow[0].id as number;
          reuseExistingWindow = true;
          if (Number(existingWindow[0].content_analyzed ?? 0) === 0) {
            await tx`
              UPDATE watcher_windows
              SET extracted_data = ${sql.json(cleanedExtractedData)},
                  model_used = ${provenanceModel},
                  client_id = ${provenanceClientId},
                  run_metadata = ${sql.json(provenanceMetadata)},
                  run_id = COALESCE(${watcherRunId}, run_id)
              WHERE id = ${windowId} AND watcher_id = ${watcherId}
            `;
          } else if (watcherRunId != null) {
            await tx`
              UPDATE watcher_windows
              SET run_id = COALESCE(${watcherRunId}, run_id)
              WHERE id = ${windowId} AND watcher_id = ${watcherId}
            `;
          }
        } else {
          throw new Error(
            `Window already exists for watcher ${watcherId} for period ${window_start} to ${window_end}. ` +
              'Use replace_existing: true to replace it, or query a different time period.'
          );
        }
      }

      if (!reuseExistingWindow) {
        const newWindowId = await getNextNumericId(tx, 'watcher_windows');

        // Single INSERT with ALL final values
        // UNIQUE index idx_watcher_windows_unique_period prevents race conditions
        try {
          await tx`
            INSERT INTO watcher_windows (
              id,
              watcher_id, version_id, window_start, window_end, granularity,
              extracted_data, content_analyzed, model_used, client_id, run_metadata, run_id, created_at
            ) VALUES (
              ${newWindowId},
              ${watcherId}, ${resolvedVersionId}, ${window_start}, ${window_end}, ${timeGranularity},
              ${sql.json(cleanedExtractedData)}, ${uniqueContentIds.length}, ${provenanceModel}, ${provenanceClientId}, ${sql.json(provenanceMetadata)}, ${watcherRunId}, NOW()
            )
          `;
        } catch (err: any) {
          if (err?.code === '23505') {
            throw new Error(
              `Window already exists for watcher ${watcherId} for period ${window_start} to ${window_end}. ` +
                'Use replace_existing: true to replace it, or query a different time period.'
            );
          }
          throw err;
        }
        windowId = newWindowId;
        windowCreated = true;
        logger.info(
          `[complete_window] Created window ${windowId} for watcher ${watcherId} (${window_start} - ${window_end})`
        );
      }
    }

    // ============================================
    // STEP 8: Link content to window (bulk INSERT)
    // Build VALUES clause for bulk insert
    // ============================================
    if (uniqueContentIds.length > 0) {
      let nextWindowEventId = await getNextNumericId(tx, 'watcher_window_events');
      const valuePlaceholders: string[] = [];
      const insertParams: unknown[] = [];
      let pIdx = 1;
      for (const contentId of uniqueContentIds) {
        valuePlaceholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, NOW())`);
        insertParams.push(nextWindowEventId, windowId, contentId);
        nextWindowEventId += 1;
        pIdx += 3;
      }

      await tx.unsafe(
        `INSERT INTO watcher_window_events (id, window_id, event_id, created_at)
         VALUES ${valuePlaceholders.join(', ')}
         ON CONFLICT DO NOTHING`,
        insertParams
      );
    }

    // ============================================
    // STEP 9: Process classifications
    // If this fails (e.g., embeddings service down), the transaction rolls back
    // ============================================
    const validContentIds = new Set(uniqueContentIds);
    await processWatcherClassifications(
      tx,
      watcherId,
      windowId,
      extractedData,
      classifiers,
      validContentIds,
      env
    );

    let runMarkedCompleted = false;
    if (watcherRunId && Number.isFinite(watcherRunId)) {
      // Scope by watcher_id so a wrong/stale watcher_run_id (passed in
      // run_metadata) cannot mark another watcher's run completed against
      // this watcher's window.
      const completedRows = await tx`
        UPDATE runs
        SET status = 'completed',
            window_id = ${windowId},
            completed_at = current_timestamp,
            error_message = NULL
        WHERE id = ${watcherRunId}
          AND watcher_id = ${watcherId}
          AND run_type = 'watcher'
          AND status IN ('running', 'claimed')
        RETURNING id
      `;
      runMarkedCompleted = completedRows.length > 0;
    }

    // Advance the schedule only when we actually did new work. Idempotent
    // replays (no window created, no run transitioned) must not push
    // next_run_at forward, or each retry would shift the schedule.
    if (windowCreated || runMarkedCompleted) {
      const watcherScheduleRows = await tx`
        SELECT schedule, next_run_at
        FROM watchers
        WHERE id = ${watcherId}
        LIMIT 1
      `;
      const watcherSchedule = (watcherScheduleRows[0]?.schedule as string | null) ?? null;
      const currentNextRunAt = (watcherScheduleRows[0]?.next_run_at as string | null) ?? null;
      if (watcherSchedule) {
        const nextRunBase = currentNextRunAt
          ? new Date(Math.max(Date.now(), new Date(currentNextRunAt).getTime()))
          : new Date();
        await tx`
          UPDATE watchers
          SET next_run_at = ${nextRunAt(watcherSchedule, nextRunBase)}::timestamptz,
              updated_at = NOW()
          WHERE id = ${watcherId}
        `;
      }
    }

    logger.info(
      `[manage_watchers] Completed window ${windowId} for watcher ${watcherId} ` +
        `(${window_start} - ${window_end}), linked ${uniqueContentIds.length} content items`
    );

    return {
      action: 'complete_window' as const,
      watcher_id: String(watcherId),
      window_id: windowId,
      window_start,
      window_end,
      content_linked: uniqueContentIds.length,
    };
  });

  // Execute reaction script inline (in-process via QuickJS WASM sandbox).
  // Skip entirely when no content was linked — zero-content windows carry no
  // new signal for the reaction to act on.
  let reactionStatus: 'success' | 'failed' | 'skipped' = 'skipped';
  let reactionError: string | undefined;

  // Fetch watcher metadata once — used for both reaction script and auto-notify
  const watcherMetaSql = getDb();
  const watcherMetaRows = await watcherMetaSql`
    SELECT w.reaction_script_compiled, w.entity_ids,
           w.organization_id, w.current_version_id,
           w.name,
           wv.version as watcher_version
    FROM watchers w
    LEFT JOIN watcher_versions wv ON w.current_version_id = wv.id
    WHERE w.id = ${result.watcher_id}
  `;

  try {
    const sql = watcherMetaSql;
    const scriptRows = watcherMetaRows;
    if (
      result.content_linked > 0 &&
      scriptRows.length > 0 &&
      scriptRows[0].reaction_script_compiled
    ) {
      const row = scriptRows[0];
      const orgId = row.organization_id as string;

      // Fetch all entities
      const eIds = Array.isArray(row.entity_ids) ? row.entity_ids.map(Number) : [];
      const entityRows =
        eIds.length > 0
          ? await sql`
              SELECT e.id, e.name, et.slug AS entity_type, e.metadata
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.id = ANY(${`{${eIds.join(',')}}`}::bigint[])
            `
          : [];

      // Fetch watcher name from version, slug from template (pre-consolidation)
      const watcherMeta = await sql`
        SELECT w.id, COALESCE(wv.name, 'watcher-' || w.id) as name,
               COALESCE(w.slug, 'watcher-' || w.id) as slug
        FROM watchers w
        LEFT JOIN watcher_versions wv ON w.current_version_id = wv.id
        WHERE w.id = ${result.watcher_id}
      `;

      const reactionContext = {
        extracted_data: cleanedExtractedData,
        entities: entityRows.map((e: any) => ({
          id: Number(e.id),
          name: e.name as string,
          entity_type: e.entity_type as string,
          metadata: (e.metadata ?? {}) as Record<string, unknown>,
        })),
        window: {
          id: result.window_id,
          watcher_id: Number(result.watcher_id),
          window_start: result.window_start,
          window_end: result.window_end,
          granularity: timeGranularity,
          content_analyzed: uniqueContentIds.length,
        },
        watcher: {
          id: Number(result.watcher_id),
          slug: (watcherMeta[0]?.slug ?? `watcher-${result.watcher_id}`) as string,
          name: (watcherMeta[0]?.name ?? `watcher-${result.watcher_id}`) as string,
          version: Number(row.watcher_version ?? 1),
        },
        organization_id: orgId,
      };

      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const execResult = await executeReaction({
          compiledScript: row.reaction_script_compiled as string,
          context: reactionContext,
          env: env as Record<string, string | undefined>,
        });

        await trackWatcherReaction({
          organizationId: orgId,
          watcherId: Number(result.watcher_id),
          windowId: result.window_id,
          reactionType: 'script_execution',
          toolName: 'reaction_executor',
          toolArgs: { attempt },
          toolResult: { success: execResult.success, error: execResult.error },
        });

        if (execResult.success) {
          reactionStatus = 'success';
          logger.info(
            { watcher_id: result.watcher_id, window_id: result.window_id, attempt },
            'Reaction script executed successfully (inline)'
          );
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(
            { watcher_id: result.watcher_id, attempt, error: execResult.error },
            'Reaction script failed, retrying...'
          );
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          reactionStatus = 'failed';
          reactionError = execResult.error;
          logger.error(
            { watcher_id: result.watcher_id, error: execResult.error },
            'Reaction script failed after all retries'
          );
        }
      }
    }
  } catch (err) {
    reactionStatus = 'failed';
    reactionError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, '[manage_watchers] Failed to execute reaction script');
  }

  return { ...result, reaction_status: reactionStatus, reaction_error: reactionError };
}

async function handleTrigger(
  args: ManageWatchersArgs,
  env: Env
): Promise<{ action: 'trigger'; watcher_id: string; run_id: number; status: string }> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for trigger action');
  }

  if (!isLobuGatewayRunning()) {
    throw new Error('Embedded Lobu is not available.');
  }
  const dispatchResult = await queueAndDispatchWatcherRun(
    Number(args.watcher_id),
    'manual',
    env,
    sql
  );

  if (dispatchResult.dispatch.failed > 0) {
    const failedRun = await getWatcherRunInfo(dispatchResult.runId, sql);
    throw new Error(failedRun?.error_message || 'Failed to dispatch watcher run.');
  }

  return {
    action: 'trigger',
    watcher_id: args.watcher_id,
    run_id: dispatchResult.runId,
    status: dispatchResult.status,
  };
}

async function handleSetReactionScript(
  args: ManageWatchersArgs,
  _env: Env
): Promise<{
  action: 'set_reaction_script';
  watcher_id: string;
  has_script: boolean;
  message: string;
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for set_reaction_script');
  }

  await requireExists(sql, 'watchers', args.watcher_id, 'Watcher');

  // Reaction script is a group-shared field — every assignment in the
  // group runs the same reactions on its windows. Resolve the group once
  // and cascade across all assignments so we don't silently fork.
  const groupRows = await sql`
    SELECT watcher_group_id FROM watchers WHERE id = ${args.watcher_id} LIMIT 1
  `;
  const groupId = Number(groupRows[0].watcher_group_id);

  const script = args.reaction_script;

  if (!script || script.trim() === '') {
    await sql`
      UPDATE watchers
      SET reaction_script = NULL, reaction_script_compiled = NULL
      WHERE watcher_group_id = ${groupId}
    `;
    return {
      action: 'set_reaction_script',
      watcher_id: String(args.watcher_id),
      has_script: false,
      message: 'Reaction script removed.',
    };
  }

  const compiledCode = await compileReactionScript(script);

  await sql`
    UPDATE watchers
    SET reaction_script = ${script}, reaction_script_compiled = ${compiledCode}
    WHERE watcher_group_id = ${groupId}
  `;

  logger.info(`[manage_watchers] Set reaction script for watcher ${args.watcher_id}`);

  return {
    action: 'set_reaction_script',
    watcher_id: String(args.watcher_id),
    has_script: true,
    message:
      'Reaction script compiled and saved. It will auto-execute on future complete_window calls.',
  };
}

async function handleDelete(args: ManageWatchersArgs): Promise<{
  action: 'delete';
  results: WatcherOperationResult[];
  summary: { total: number; successful: number; failed: number };
}> {
  const sql = getDb();

  if (!args.watcher_ids || args.watcher_ids.length === 0) {
    throw new Error('watcher_ids is required and cannot be empty');
  }

  const results: WatcherOperationResult[] = [];

  for (const watcherId of args.watcher_ids) {
    try {
      const updated = await sql`
        UPDATE watchers
        SET status = 'archived', updated_at = NOW()
        WHERE id = ${watcherId} AND status != 'archived'
        RETURNING id, name, entity_ids, organization_id
      `;

      if (updated.length === 0) {
        results.push({
          watcher_id: watcherId,
          success: false,
          message: 'Watcher not found or already archived',
        });
      } else {
        const watcher = updated[0];
        const entityIds = Array.isArray(watcher.entity_ids) ? watcher.entity_ids : [];

        // Record change event in knowledge for audit trail
        if (entityIds.length > 0 && watcher.organization_id) {
          recordChangeEvent({
            entityIds: entityIds.map(Number),
            organizationId: watcher.organization_id as string,
            title: `Watcher archived: ${watcher.name || watcherId}`,
            content: `Watcher "${watcher.name || watcherId}" (id: ${watcherId}) was archived.`,
            metadata: {
              action: 'watcher_archived',
              watcher_id: watcherId,
              watcher_name: watcher.name,
            },
          });
        }

        results.push({
          watcher_id: watcherId,
          success: true,
          message: 'Watcher archived successfully',
        });
      }
    } catch (error) {
      results.push({
        watcher_id: watcherId,
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    action: 'delete',
    results,
    summary: summarizeResults(results),
  };
}

async function handleList(
  args: ListWatchersArgs,
  _env: Env,
  ctx: ToolContext
): Promise<ListWatchersResult> {
  const sql = getDb();

  if (args.entity_id) {
    const entityCheck = await sql`SELECT id FROM entities WHERE id = ${args.entity_id}`;
    if (entityCheck.length === 0) {
      throw new Error(`Entity with ID ${args.entity_id} not found`);
    }
  }

  let query = `
    SELECT
      i.id as watcher_id,
      i.name,
      i.slug,
      i.status,
      i.version,
      i.created_at,
      i.updated_at,
      i.schedule,
      i.next_run_at,
      i.agent_id,
      i.scheduler_client_id,
      i.model_config,
      i.sources,
      i.tags,
      i.watcher_group_id,
      i.source_watcher_id,
      wr.id as watcher_run_id,
      wr.status as watcher_run_status,
      wr.error_message as watcher_run_error,
      wr.created_at as watcher_run_created_at,
      wr.completed_at as watcher_run_completed_at,
      e.id as entity_id,
      et.slug AS entity_type,
      e.name as entity_name,
      e.slug as entity_slug,
      e.organization_id,
      parent.id as parent_id,
      parent.name as parent_name,
      parent.slug as parent_slug,
      pet.slug as parent_entity_type,
      i.current_version_id,
      (SELECT COUNT(*) FROM watcher_windows iw WHERE iw.watcher_id = i.id) as windows_count
  `;

  if (args.include_details) {
    query += `,
      cv.description,
      cv.prompt,
      cv.extraction_schema,
      cv.classifiers,
      cv.json_template,
      cv.keying_config,
      cv.condensation_prompt,
      cv.condensation_window_count,
      cv.reactions_guidance
    `;
  }

  query += `
    FROM watchers i
    LEFT JOIN entities e ON e.id = ANY(i.entity_ids)
    LEFT JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities parent ON e.parent_id = parent.id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    LEFT JOIN watcher_versions cv ON i.current_version_id = cv.id
    ${buildLatestWatcherRunJoinSql('i', 'wr')}
  `;

  const conditions: string[] = [];
  const params: any[] = [];
  let paramCount = 1;

  conditions.push(`i.organization_id = $${paramCount}::text`);
  params.push(ctx.organizationId);
  paramCount++;

  if (args.entity_id) {
    conditions.push(`$${paramCount} = ANY(i.entity_ids)`);
    params.push(args.entity_id);
    paramCount++;
  }

  if (args.watcher_id) {
    conditions.push(`i.id = $${paramCount}`);
    params.push(args.watcher_id);
    paramCount++;
  }

  if (args.status) {
    conditions.push(`i.status = $${paramCount}`);
    params.push(args.status);
    paramCount++;
  } else {
    // Default to active watchers only (exclude archived)
    conditions.push(`i.status = 'active'`);
  }

  query += ` WHERE ${conditions.join(' AND ')}`;
  query += ' ORDER BY i.created_at DESC';

  const result = await sql.unsafe(query, params);

  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  const watcherIds = (result as any[]).map((i) => Number(i.watcher_id));

  let counts: Map<number, { pending: number; historical: number }>;
  try {
    counts = await batchCountUnanalyzedContent(watcherIds);
  } catch (error) {
    logger.error({ error }, '[manage_watchers] Error batch counting unanalyzed content');
    counts = new Map();
  }

  const uniqueOrgIds = [
    ...new Set((result as any[]).map((r) => r.organization_id as string).filter(Boolean)),
  ];
  const orgSlugMap = new Map<string, string>();
  for (const orgId of uniqueOrgIds) {
    const slug = await getOrganizationSlug(orgId);
    if (slug) orgSlugMap.set(orgId, slug);
  }

  const watchersWithPendingCount = (result as any[]).map((watcher) => {
    const watcherId = Number(watcher.watcher_id);
    const countData = counts.get(watcherId) || { pending: 0, historical: 0 };
    const orgSlug = orgSlugMap.get(watcher.organization_id as string) ?? null;

    const entityInfo: EntityInfo | null = orgSlug
      ? {
          ownerSlug: orgSlug,
          entityType: watcher.entity_type,
          slug: watcher.entity_slug,
          parentType: watcher.parent_entity_type ?? null,
          parentSlug: watcher.parent_slug ?? null,
        }
      : null;
    const viewUrl = entityInfo ? buildWatchersUrl(entityInfo, baseUrl) : undefined;

    const { organization_id: _orgId, ...rest } = watcher;

    if (!args.include_details) {
      delete (rest as Record<string, unknown>).prompt;
      delete (rest as Record<string, unknown>).extraction_schema;
      delete (rest as Record<string, unknown>).classifiers;
      delete (rest as Record<string, unknown>).json_template;
      delete (rest as Record<string, unknown>).description;
    }

    return {
      ...rest,
      organization_slug: orgSlug,
      pending_content_count: countData.pending,
      historical_content_count: countData.historical,
      view_url: viewUrl,
    };
  });

  return { watchers: watchersWithPendingCount };
}

// ============================================
// Version Management Handlers
// ============================================

async function handleCreateVersion(
  args: ManageWatchersArgs,
  _env: Env,
  ctx: ToolContext
): Promise<{
  action: 'create_version';
  watcher_id: string;
  version_id: string;
  version: number;
  previous_version: number;
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for create_version action');
  }

  // Get current watcher + resolve the group root. Versioned config
  // (prompt/schema/template/classifiers) is shared across the entire group
  // and version rows live on the group root, so we read from and write to
  // `watcher_id = watcher_group_id`. The arg's watcher_id is only used to
  // identify the group and to apply the per-assignment writes (sources,
  // schedule, scheduler_client_id) to that specific row.
  const watcherRows = await sql`
    SELECT i.id, i.version, i.current_version_id, i.watcher_group_id, i.sources
    FROM watchers i WHERE i.id = ${args.watcher_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Watcher ${args.watcher_id} not found`);
  }

  const groupId = Number(watcherRows[0].watcher_group_id);
  const previousVersion = Number(watcherRows[0].version);
  const nextVersion = previousVersion + 1;

  // Load current version (from the group root's chain) to inherit fields
  // the caller didn't specify.
  const prevRows = await sql`
    SELECT
      name, description, prompt, extraction_schema, version_sources,
      json_template, keying_config, classifiers,
      reactions_guidance, condensation_prompt, condensation_window_count
    FROM watcher_versions
    WHERE watcher_id = ${groupId}
    ORDER BY version DESC LIMIT 1
  `;
  if (prevRows.length === 0) {
    throw new Error(
      `No previous version found for watcher group ${groupId}. ` +
        'This group is missing version rows on its root — likely a stale clone from before the version-sharing refactor. Run cleanup or create a fresh watcher.'
    );
  }
  const prev = prevRows[0] as Record<string, unknown>;

  const prompt = args.prompt ?? (prev.prompt as string);
  const extractionSchema =
    parseJsonInput<Record<string, unknown>>(args.extraction_schema, 'extraction_schema') ??
    normalizeStoredJsonField(prev.extraction_schema, {} as Record<string, unknown>);
  // Sources are per-assignment now. When the caller omits args.sources we
  // keep the seed watcher's existing sources; we deliberately do not fall
  // back to prev.version_sources from the prior version row, because
  // version_sources is no longer written and is a vestigial column.
  const sources =
    args.sources ??
    normalizeStoredJsonField(
      watcherRows[0].sources,
      [] as Array<{ name: string; query: string }>
    );
  const jsonTemplate =
    parseJsonInput<unknown>(args.json_template, 'json_template') ??
    normalizeStoredJsonField(prev.json_template, undefined as unknown);
  const keyingConfig =
    parseJsonInput<Record<string, unknown>>(args.keying_config, 'keying_config') ??
    normalizeStoredJsonField(prev.keying_config, undefined as Record<string, unknown> | undefined);
  const classifiers =
    parseJsonInput<unknown[]>(args.classifiers, 'classifiers') ??
    normalizeStoredJsonField(prev.classifiers, undefined as unknown[] | undefined);

  // Validate
  const validation = validateWatcherConfig({
    prompt,
    extraction_schema: extractionSchema,
    classifiers,
    sources,
  });
  if (validation) {
    throw new Error(`Watcher validation failed: ${validation}`);
  }

  if (classifiers && extractionSchema) {
    const classifierValidation = validateClassifierSourcePaths(
      classifiers as Array<{ slug: string; source_path?: string }>,
      extractionSchema
    );
    if (classifierValidation) {
      throw new Error(`Classifier-schema compatibility error: ${classifierValidation}`);
    }
  }

  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      throw new Error(scheduleError);
    }
  }

  const createdBy = ctx.userId ?? 'system';
  const versionId = await getNextWatcherVersionId(sql);
  let lockedNextVersion = nextVersion;
  await sql.begin(async (tx) => {
    // Serialize concurrent create_version calls on the same group. The
    // unique (watcher_id, version) index would otherwise reject one of two
    // simultaneous N+1 inserts and surface as a 500. The advisory lock is
    // tx-scoped (auto-released on commit/rollback) and keyed by group id,
    // so unrelated groups are unaffected.
    await tx`SELECT pg_advisory_xact_lock(hashtext('watcher_create_version'), ${groupId})`;

    // Re-resolve the latest version under the lock so we don't race with a
    // call that already committed N+1 while we were computing nextVersion.
    const latestRows = await tx`
      SELECT MAX(version) AS v FROM watcher_versions WHERE watcher_id = ${groupId}
    `;
    lockedNextVersion =
      latestRows.length > 0 && latestRows[0].v != null ? Number(latestRows[0].v) + 1 : nextVersion;

    // The new version row is owned by the group root, not the assignment
    // the caller named. Every watcher in the group will later point at
    // this row via current_version_id.
    // version_sources is intentionally NULL on the new version row: sources
    // are per-assignment now, so storing one assignment's sources in the
    // shared version row would let one assignment's source list override
    // every other assignment's sources via get_content's preference order.
    // get_content falls through to watchers.sources when version_sources is
    // empty, which is the right per-assignment behavior.
    await tx`
      INSERT INTO watcher_versions (
        id, watcher_id, version, name, description,
        prompt, extraction_schema, version_sources,
        json_template, keying_config, classifiers,
        condensation_prompt, condensation_window_count,
        reactions_guidance, change_notes, created_by, created_at
      ) VALUES (
        ${versionId}, ${groupId}, ${lockedNextVersion},
        ${args.name ?? (prev.name as string) ?? 'Watcher'},
        ${args.description !== undefined ? (args.description ?? null) : ((prev.description as string) ?? null)},
        ${prompt}, ${toJsonParam(tx, extractionSchema)}, NULL,
        ${toJsonParam(tx, jsonTemplate)}, ${toJsonParam(tx, keyingConfig)}, ${toJsonParam(tx, classifiers)},
        ${args.condensation_prompt ?? (prev.condensation_prompt as string) ?? null},
        ${args.condensation_window_count ?? (prev.condensation_window_count as number) ?? null},
        ${args.reactions_guidance ?? (prev.reactions_guidance as string) ?? null},
        ${args.change_notes ?? null}, ${createdBy}, NOW()
      )
    `;

    // Update watcher to new version if set_as_current (default: true).
    // Group-shared fields (current_version_id, version, name) cascade to
    // every watcher in the group; per-assignment fields (sources,
    // schedule, scheduler_client_id) update only the targeted row.
    const setAsCurrent = args.set_as_current !== false;
    if (setAsCurrent) {
      const shouldUpdateSchedule = args.schedule !== undefined;
      const scheduleValue = shouldUpdateSchedule ? args.schedule || null : null;
      const nextRunAtVal = scheduleValue ? nextRunAt(scheduleValue) : null;

      // Group-shared cascade
      await tx`
        UPDATE watchers
        SET
          current_version_id = ${versionId},
          version = ${lockedNextVersion},
          name = ${args.name ?? (prev.name as string)},
          updated_at = NOW()
        WHERE watcher_group_id = ${groupId}
      `;

      // Per-assignment writes (only the row the caller named)
      await tx`
        UPDATE watchers
        SET
          sources = ${tx.json(sources)},
          scheduler_client_id = CASE WHEN ${args.scheduler_client_id !== undefined} THEN ${args.scheduler_client_id ?? null} ELSE scheduler_client_id END,
          schedule = CASE WHEN ${shouldUpdateSchedule} THEN ${scheduleValue} ELSE schedule END,
          next_run_at = CASE WHEN ${shouldUpdateSchedule} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END
        WHERE id = ${args.watcher_id}
      `;
    }
  });

  return {
    action: 'create_version',
    watcher_id: args.watcher_id,
    version_id: String(versionId),
    version: lockedNextVersion,
    previous_version: previousVersion,
  };
}

async function handleGetVersions(args: ManageWatchersArgs): Promise<{
  action: 'get_versions';
  watcher_id: string;
  versions: any[];
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for get_versions action');
  }

  const watcherRows = await sql`
    SELECT id, name, slug, current_version_id FROM watchers WHERE id = ${args.watcher_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Watcher ${args.watcher_id} not found`);
  }

  const currentVersionId = watcherRows[0].current_version_id;

  const versionRows = await sql`
    SELECT
      v.id as version_id,
      v.version,
      v.name,
      v.description,
      v.created_at,
      v.created_by,
      v.change_notes
    FROM watcher_versions v
    WHERE v.watcher_id = ${args.watcher_id}
    ORDER BY v.version DESC
  `;

  const resolvedRows = await resolveUsernames(
    versionRows as unknown as Record<string, unknown>[],
    'created_by'
  );

  const versions = resolvedRows.map((row: any) => ({
    version_id: String(row.version_id),
    version: Number(row.version),
    name: row.name,
    description: row.description,
    is_current: Number(row.version_id) === Number(currentVersionId),
    created_at: row.created_at,
    created_by: row.created_by_username || row.created_by,
    change_notes: row.change_notes,
  }));

  return {
    action: 'get_versions',
    watcher_id: args.watcher_id,
    versions,
  };
}

async function handleGetVersionDetails(args: ManageWatchersArgs): Promise<ManageWatchersResult> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for get_version_details action');
  }

  let rows;
  if (args.version !== undefined) {
    rows = await sql`
      SELECT
        id, version, name, description, prompt,
        extraction_schema, version_sources, json_template,
        keying_config, classifiers,
        condensation_prompt, condensation_window_count,
        reactions_guidance
      FROM watcher_versions
      WHERE watcher_id = ${args.watcher_id} AND version = ${args.version}
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT
        v.id, v.version, v.name, v.description, v.prompt,
        v.extraction_schema, v.version_sources, v.json_template,
        v.keying_config, v.classifiers,
        v.condensation_prompt, v.condensation_window_count,
        v.reactions_guidance
      FROM watcher_versions v
      JOIN watchers w ON v.id = w.current_version_id
      WHERE w.id = ${args.watcher_id}
      LIMIT 1
    `;
  }

  if (rows.length === 0) {
    throw new Error(
      `Version ${args.version ?? 'current'} not found for watcher ${args.watcher_id}`
    );
  }

  const v = rows[0] as Record<string, unknown>;

  return {
    action: 'get_version_details',
    watcher_id: args.watcher_id,
    version_id: String(v.id),
    version: Number(v.version),
    name: v.name as string | undefined,
    description: v.description as string | undefined,
    prompt: v.prompt as string,
    extraction_schema: normalizeStoredJsonField(v.extraction_schema, undefined as unknown),
    sources: normalizeStoredJsonField(
      v.version_sources,
      [] as Array<{ name: string; query: string }>
    ),
    json_template: normalizeStoredJsonField(v.json_template, undefined as unknown),
    keying_config: normalizeStoredJsonField(v.keying_config, undefined as unknown),
    classifiers: normalizeStoredJsonField(v.classifiers, undefined as unknown[] | undefined),
    condensation_prompt: v.condensation_prompt as string | undefined,
    condensation_window_count: v.condensation_window_count as number | undefined,
    reactions_guidance: v.reactions_guidance as string | undefined,
  };
}

// ============================================
// Feedback Handlers
// ============================================

type CorrectionInput = {
  field_path: string;
  mutation?: 'set' | 'remove' | 'add';
  value?: unknown;
  note?: string;
};

async function handleSubmitFeedback(
  args: ManageWatchersArgs,
  ctx: ToolContext
): Promise<ManageWatchersResult> {
  if (!args.watcher_id) throw new Error('watcher_id is required');
  if (!args.window_id) throw new Error('window_id is required');
  if (!ctx.userId) {
    throw new Error('Authentication required to submit feedback');
  }
  const corrections = args.corrections as CorrectionInput[] | undefined;
  if (!Array.isArray(corrections) || corrections.length === 0) {
    throw new Error('corrections must be a non-empty array of {field_path, ...} entries');
  }

  for (const c of corrections) {
    if (!c.field_path || typeof c.field_path !== 'string') {
      throw new Error('each correction requires a string field_path');
    }
    const m = c.mutation ?? 'set';
    if (m !== 'set' && m !== 'remove' && m !== 'add') {
      throw new Error(`unsupported mutation "${m}" for ${c.field_path}`);
    }
    if ((m === 'set' || m === 'add') && c.value === undefined) {
      throw new Error(`${m} correction for ${c.field_path} requires a value`);
    }
  }

  const sql = getDb();
  const watcherId = Number(args.watcher_id);

  // Scope to the caller's current org so a member of org A can't write
  // feedback against a watcher in org B by passing its watcher_id.
  const windowCheck = await sql`
    SELECT ww.id, w.organization_id
    FROM watcher_windows ww
    JOIN watchers w ON ww.watcher_id = w.id
    WHERE ww.id = ${args.window_id}
      AND ww.watcher_id = ${watcherId}
      AND w.organization_id = ${ctx.organizationId}
  `;
  if (windowCheck.length === 0) {
    throw new Error(`Window ${args.window_id} not found for watcher ${watcherId}`);
  }
  const organizationId = windowCheck[0].organization_id as string;

  // Insert in one transaction so a partial failure never leaks half-applied
  // corrections — submit_feedback is naturally a batch operation from the UI.
  const feedbackIds = await sql.begin(async (tx) => {
    const ids: number[] = [];
    for (const c of corrections) {
      const mutation = c.mutation ?? 'set';
      const correctedValueJson =
        mutation === 'remove' || c.value === undefined ? null : tx.json(c.value);
      const result = await tx`
        INSERT INTO watcher_window_field_feedback (
          window_id, watcher_id, organization_id,
          field_path, mutation, corrected_value, note, created_by
        )
        VALUES (
          ${args.window_id}, ${watcherId}, ${organizationId},
          ${c.field_path}, ${mutation}, ${correctedValueJson},
          ${c.note ?? null}, ${ctx.userId}
        )
        RETURNING id
      `;
      ids.push(Number(result[0].id));
    }
    return ids;
  });

  return {
    action: 'submit_feedback',
    watcher_id: args.watcher_id,
    window_id: args.window_id,
    feedback_ids: feedbackIds,
  };
}

async function handleGetFeedback(
  args: ManageWatchersArgs,
  ctx: ToolContext
): Promise<ManageWatchersResult> {
  if (!args.watcher_id) throw new Error('watcher_id is required');

  const sql = getDb();
  const watcherId = Number(args.watcher_id);
  const limit = args.limit ?? 50;

  // Scope to the caller's current org so a member of org A can't enumerate
  // feedback for a watcher in org B by passing its watcher_id.
  const feedback = args.window_id
    ? await sql`
        SELECT f.id, f.window_id, f.field_path, f.mutation, f.corrected_value,
               f.note, f.created_by, f.created_at,
               w.window_start, w.window_end
        FROM watcher_window_field_feedback f
        JOIN watcher_windows w ON f.window_id = w.id
        WHERE f.watcher_id = ${watcherId}
          AND f.window_id = ${args.window_id}
          AND f.organization_id = ${ctx.organizationId}
        ORDER BY f.created_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT f.id, f.window_id, f.field_path, f.mutation, f.corrected_value,
               f.note, f.created_by, f.created_at,
               w.window_start, w.window_end
        FROM watcher_window_field_feedback f
        JOIN watcher_windows w ON f.window_id = w.id
        WHERE f.watcher_id = ${watcherId}
          AND f.organization_id = ${ctx.organizationId}
        ORDER BY f.created_at DESC
        LIMIT ${limit}
      `;

  return {
    action: 'get_feedback',
    watcher_id: args.watcher_id,
    feedback: feedback.map((row) => ({
      id: Number(row.id),
      window_id: Number(row.window_id),
      field_path: row.field_path as string,
      mutation: row.mutation as 'set' | 'remove' | 'add',
      corrected_value: row.corrected_value as unknown,
      note: row.note as string | null,
      created_by: row.created_by as string,
      created_at: (row.created_at as Date).toISOString(),
      window_start: row.window_start ? (row.window_start as Date).toISOString() : undefined,
      window_end: row.window_end ? (row.window_end as Date).toISOString() : undefined,
    })),
  };
}

function handleGetComponentReference(): {
  action: 'get_component_reference';
  documentation: ComponentReferenceDocumentation;
} {
  return {
    action: 'get_component_reference',
    documentation: {
      overview:
        'Watchers define extraction prompts, schemas, SQL source queries, and optional JSON rendering.',
      data_types: [
        {
          type: 'source',
          description:
            'SQL data source query. If it references the events table, time window bounds are auto-applied via CTE scoping.',
          required_fields: ['name', 'query'],
          example: {
            name: 'daily_volume',
            query:
              "SELECT DATE_TRUNC('day', occurred_at) as day, COUNT(*) as count FROM events GROUP BY 1 ORDER BY 1",
          },
        },
      ],
      available_components: [
        {
          name: 'card',
          category: 'Layout',
          description: 'Container with border and padding.',
          example: { type: 'card', children: [{ type: 'text', content: 'Content' }] },
        },
        {
          name: 'each',
          category: 'Control flow',
          description: 'Iterates over arrays in data payload.',
          example: {
            type: 'each',
            items: 'items',
            as: 'item',
            render: { type: 'data', path: 'item.name' },
          },
        },
      ],
      template_variables: [
        {
          variable: '{{entities}}',
          description: 'Comma-separated entity names.',
        },
        {
          variable: '{{#each entities}}{{name}}, {{type}}, {{id}}{{/each}}',
          description: 'Iterate over entities with access to name, type, and id.',
        },
        {
          variable: '{{content}}',
          description: 'All content items formatted as readable text.',
        },
        {
          variable: '{{sources.name}}',
          description: 'Content from a specific named source.',
        },
        {
          variable: '{{data.name}}',
          description: 'Results from a named SQL data source.',
        },
        {
          variable: '{{#each sources}}{{name}}, {{content}}, {{count}}{{/each}}',
          description: 'Iterate over all sources.',
        },
      ],
      security_restrictions: [
        'Templates are declarative; arbitrary JavaScript execution is not supported.',
        'SQL queries are restricted to read-only SELECT/WITH statements.',
      ],
      complete_examples: [
        {
          name: 'Problem Detection',
          description: 'Extracts recurring product issues from source content.',
          prompt: 'Analyze {{entities}} feedback and extract recurring problems.',
          extraction_schema: {
            type: 'object',
            properties: {
              problems: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string' }, severity: { type: 'string' } },
                  required: ['name', 'severity'],
                },
              },
            },
            required: ['problems'],
          },
          data: {
            daily_volume: {
              query:
                "SELECT DATE_TRUNC('day', occurred_at) as day, COUNT(*) as count FROM events GROUP BY 1 ORDER BY 1",
            },
          },
        },
      ],
    },
  };
}
