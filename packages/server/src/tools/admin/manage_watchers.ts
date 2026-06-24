/**
 * Tool: manage_watchers
 *
 * Manage self-contained watcher definitions with client-driven execution.
 *
 * Actions:
 * - create: Create watcher with prompt/schema/sources directly
 * - update: Modify config (model, schedule, sources)
 * - create_version: Create a new version for a watcher (prompt/schema/sources)
 * - create_from_version: Create a new watcher from an existing version
 * - complete_window: Complete a window using window_token from read_knowledge
 * - trigger: Manually trigger a watcher run
 * - delete: Remove watcher
 * - set_reaction_script: Attach automated TypeScript reaction
 * - get_versions: View version history for a watcher
 * - get_version_details: Get full config for a specific version
 * - get_component_reference: Get available components and data types documentation
 * - submit_feedback: Submit feedback on a watcher window
 * - get_feedback: Retrieve feedback for a watcher
 *
 * This file is the entry point only — action handlers live in ./manage_watchers/.
 */

import { type Static, Type } from '@sinclair/typebox';
import { createDbClientFromEnv } from '../../db/client';
import type { Env } from '../../index';
import type { ComponentReferenceDocumentation } from '../../types/templates';
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
  requireReadAccess,
  requireWriteAccess,
} from '../../utils/organization-access';
import { WatcherExecutionConfigSchema } from './watcher-execution-config';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { defineFlatActionTool, flatAction } from './action-tool';
import { requireWatcherAccess } from './manage_watchers/shared';
import { handleCreate, handleUpdate, handleDelete, handleCreateFromVersion } from './manage_watchers/crud';
import { handleCreateVersion, handleGetVersions, handleGetVersionDetails } from './manage_watchers/version-actions';
import { handleCompleteWindow } from './manage_watchers/complete-window';
import { handleTrigger, handleSetReactionScript } from './manage_watchers/trigger';
import { handleSubmitFeedback, handleGetFeedback } from './manage_watchers/feedback';
import { handleGetComponentReference } from './manage_watchers/reference';
import { handleList, type ListWatchersArgs, type ListWatchersResult } from './manage_watchers/list';

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
      description:
        'Entity ID. Optional for create — provide it to attach the watcher to an entity; omit it for an org-scoped/global watcher. Optional for list.',
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
  sources: Type.Optional(
    Type.Array(SourceSchema, {
      description:
        '[create/create_version/update] Array of SQL data sources. Each source is { name, query }.',
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
  device_worker_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        '[create/update] Optional device worker UUID to pin this watcher to (when its inputs live on that device). Null clears the pin.',
    })
  ),
  agent_kind: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        '[create/update] Optional agent kind override for this watcher (e.g. "background", "notifier"). Null clears the override.',
    })
  ),
  notification_channel: Type.Optional(
    Type.Union(
      [
        Type.Literal('canvas'),
        Type.Literal('notification'),
        Type.Literal('both'),
      ],
      {
        description:
          '[create/update] Where firings surface: "canvas" (default), "notification" (OS notification), or "both".',
      }
    )
  ),
  notification_priority: Type.Optional(
    Type.Union(
      [Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')],
      {
        description:
          '[create/update] Priority class used by the dispatcher interrupt budget. Default "normal".',
      }
    )
  ),
  min_cooldown_seconds: Type.Optional(
    Type.Number({
      description:
        '[create/update] Minimum seconds between two firings of this watcher (0 = no cooldown).',
      minimum: 0,
    })
  ),
  model_config: Type.Optional(Type.Any({ description: '[create/update] AI model configuration' })),
  // Union with Null so `update` can clear a previously-saved config back to
  // NULL/defaults — omitted = unchanged, null = clear, object = replace. The
  // object shape lives in WatcherExecutionConfigSchema; the role-policy gate
  // (assertValidExecutionConfig) stays in the CRUD handlers.
  execution_config: Type.Optional(Type.Union([Type.Null(), WatcherExecutionConfigSchema])),
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
          '[complete_window] Required. LLM analysis results. Must match the watcher\'s extraction contract (derived from its entity type).',
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
        '[complete_window] JWT from read_knowledge(watcher_id, since, until). Pass this or window_tokens.',
    })
  ),
  window_tokens: Type.Optional(
    Type.Array(Type.String(), {
      description:
        '[complete_window] Multiple page JWTs from read_knowledge for the same watcher window. Content IDs are unioned and linked atomically.',
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
  watcher_run_id: Type.Optional(
    Type.Number({
      description:
        '[complete_window] Optional watcher run id for run completion/provenance. Workers should pass the Watcher run ID from the dispatch prompt.',
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

export type ManageWatchersResult =
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
      results: Array<{ watcher_id: string; success: boolean; message: string; version?: number }>;
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
  agent_id: Type.Optional(
    Type.String({
      description: 'Optional agent ID to list watchers owned by a specific agent',
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
  watcher_group_id: Type.Optional(
    Type.Number({
      description: 'Filter watchers sharing a watcher_group_id (for legacy group URL resolution)',
    })
  ),
  order_by: Type.Optional(
    Type.Union([Type.Literal('last_fired_at'), Type.Literal('created_at')], {
      description: 'Sort field. Omit for created_at DESC (default, backward compatible).',
    })
  ),
  order_dir: Type.Optional(
    Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
      description: 'Sort direction (default: desc)',
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum watchers to return (omit for all)',
    })
  ),
});

// ============================================
// Main Function
// ============================================

export const manageWatchers = withValidatedArgs(
  'manage_watchers',
  ManageWatchersSchema,
  manageWatchersImpl
);

async function manageWatchersImpl(
  args: ManageWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageWatchersResult> {
  const pgSql = createDbClientFromEnv(env);

  // Validate organization access based on action type
  if (args.action === 'create') {
    if (args.entity_id) {
      await requireWriteAccess(pgSql, args.entity_id, ctx);
    } else {
      await requireOrgWriteAccess(pgSql, ctx);
    }
  } else if (args.action === 'update' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'trigger' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'delete' && args.watcher_ids && args.watcher_ids.length > 0) {
    await requireWatcherAccess(pgSql, args.watcher_ids, ctx, 'write');
  } else if (args.action === 'complete_window' && args.entity_id) {
    await requireWriteAccess(pgSql, args.entity_id, ctx);
  } else if (args.action === 'create_version' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'set_reaction_script' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'submit_feedback' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'get_feedback' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'read');
  } else if (args.action === 'get_versions' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'read');
  } else if (args.action === 'get_version_details' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'read');
  } else if (args.action === 'create_from_version' && args.entity_ids) {
    for (const eid of args.entity_ids) {
      await requireWriteAccess(pgSql, eid, ctx);
    }
  }

  return runManageWatchers(args, env, ctx);
}

const runManageWatchers = defineFlatActionTool<ManageWatchersArgs, ManageWatchersResult>(
  'manage_watchers',
  {
    create: flatAction((args, ctx, env) => handleCreate(args, env, ctx)),
    update: flatAction((args, ctx, env) => handleUpdate(args, env, ctx)),
    create_version: flatAction((args, ctx, env) => handleCreateVersion(args, env, ctx)),
    complete_window: flatAction((args, ctx, env) => handleCompleteWindow(args, env, ctx)),
    trigger: flatAction((args, _ctx, env) => handleTrigger(args, env)),
    delete: flatAction(handleDelete),
    set_reaction_script: flatAction((args, _ctx, env) => handleSetReactionScript(args, env)),
    get_versions: flatAction(handleGetVersions),
    get_version_details: flatAction(handleGetVersionDetails),
    get_component_reference: flatAction(() => Promise.resolve(handleGetComponentReference())),
    submit_feedback: flatAction(handleSubmitFeedback),
    get_feedback: flatAction(handleGetFeedback),
    create_from_version: flatAction((args, ctx, env) => handleCreateFromVersion(args, env, ctx)),
  }
);

export const listWatchers = withValidatedArgs(
  'list_watchers',
  ListWatchersSchema,
  listWatchersImpl
);

async function listWatchersImpl(
  args: ListWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ListWatchersResult> {
  const pgSql = createDbClientFromEnv(env);
  if (args.entity_id) {
    await requireReadAccess(pgSql, args.entity_id, ctx);
  } else {
    await requireOrgReadAccess(pgSql, ctx);
  }
  return handleList(args, env, ctx);
}

