/**
 * CRUD action handlers for manage_watchers:
 *   create, update, delete, create_from_version
 */

import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { ToolUserError } from '../../../utils/errors';
import { nextRunAt, validateSchedule } from '../../../utils/cron';
import { recordChangeEvent, recordLifecycleEvent } from '../../../utils/insert-event';
import logger from '../../../utils/logger';
import { getOrganizationSlug, getPublicWebUrl, buildWatchersUrl } from '../../../utils/url-builder';
import { toEntityInfo } from '../../view-urls';
import {
  createClassifiersForWatcher,
  enableClassifiersOnEntity,
} from '../../../watchers/classifier-extraction';
import { assertDeviceWorkerAccess } from '../watcher-device-access';
import { assertValidExecutionConfig } from '../watcher-execution-config';
import { assertEntityIdsInOrg, getNextNumericId, requireExists } from '../helpers/db-helpers';
import type { ToolContext } from '../../registry';
import type { ManageWatchersArgs } from '../manage_watchers';
import {
  assertWatcherVersionConfigValid,
  assertWatcherSourcesResolve,
  parseJsonInput,
  toJsonParam,
  toTextArrayParam,
  summarizeResults,
  type WatcherOperationResult,
} from './shared';
import { getErrorMessage } from "@lobu/core";
import {
  extractSourcesFromPromptTokens,
  mergePromptSources,
} from '../../../watchers/source-refs';

// ============================================
// handleCreate
// ============================================

export async function handleCreate(
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

  // Require slug + prompt for create. The output contract is not authored
  // here: an entity-typed watcher (keying_config.entity_type) derives it from
  // entity_types.metadata_schema at runtime, and an untyped watcher uses the
  // worker's free-form summary fallback.
  if (!args.slug) {
    throw new ToolUserError('slug is required for create action');
  }
  if (!args.prompt) {
    throw new ToolUserError('prompt is required for create action');
  }
  assertValidExecutionConfig(args.execution_config, ctx);
  // A device pin runs the watcher's agent CLI on the device owner's machine —
  // validate the caller may target this device (own it, or org owner/admin
  // over a device attached to the org) before storing it.
  await assertDeviceWorkerAccess(sql, args.device_worker_id, ctx);

  // entity_id is optional: omit it for an org-scoped/global watcher.
  const entityId = args.entity_id;

  // Parse JSON inputs
  const keyingConfig = parseJsonInput<Record<string, unknown>>(args.keying_config, 'keying_config');
  const classifiers = parseJsonInput<unknown[]>(args.classifiers, 'classifiers');

  // Build sources array. Sources are authored two ways and merged here:
  //   1. `@`-mention tokens in the prompt (the owletto composer's primary path)
  //      — the backend derives them so the UI sends only the raw prompt.
  //   2. explicit `args.sources` (API callers / legacy).
  // If neither yields anything, fall back to a default all-events source.
  const promptSources = extractSourcesFromPromptTokens(args.prompt);
  const explicitSources = args.sources ?? [];
  const merged = mergePromptSources(explicitSources, promptSources);
  const sources: Array<{ name: string; query: string }> =
    merged.length > 0
      ? merged
      : [{ name: 'content', query: 'SELECT * FROM events ORDER BY occurred_at DESC' }];

  // Validate watcher config
  assertWatcherVersionConfigValid({
    prompt: args.prompt,
    classifiers,
    sources,
  });

  if (!args.agent_id) {
    // The scheduler joins on `agent_id IS NOT NULL` (see
    // packages/server/src/watchers/automation.ts:469), so a watcher without
    // an agent has no way to execute. Schema-wise `agent_id` is `Type.Optional`
    // because the field is shared across all manage_watchers actions, but
    // create enforces it: a watcher with no owning agent is a zombie row.
    throw new ToolUserError(
      'agent_id is required to create a watcher (the agent that executes it).'
    );
  }

  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      throw new ToolUserError(scheduleError);
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

  if (entityId) {
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
      throw new ToolUserError(`Entity with ID ${entityId} not found`, 404);
    }
    entityRow = entityResult[0] as EntityRow;
    organizationId = entityRow.organization_id;
    organizationSlug = await getOrganizationSlug(organizationId);
  } else {
    if (!organizationId) {
      throw new ToolUserError(
        'entity_id or an organization context is required to create a watcher'
      );
    }
    organizationSlug = await getOrganizationSlug(organizationId);
  }

  // Resolve @ref sources against the org now so a typo fails at create (422)
  // instead of producing silent empty context at read_knowledge. Custom-SQL
  // sources are skipped here; their id projection is enforced above.
  if (!organizationId) {
    throw new ToolUserError(
      'Cannot resolve watcher sources without an organization'
    );
  }
  await assertWatcherSourcesResolve(sql, organizationId, sources);

  // Check slug uniqueness within org
  const existingSlug = await sql`
    SELECT id FROM watchers
    WHERE organization_id = ${organizationId} AND slug = ${args.slug}
    LIMIT 1
  `;
  if (existingSlug.length > 0) {
    throw new ToolUserError(
      `Watcher with slug '${args.slug}' already exists in this organization`,
      409
    );
  }

  const watcherId = await getNextNumericId(sql, 'watchers');
  const versionId = await getNextNumericId(sql, 'watcher_versions');
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
        watcher_group_id,
        device_worker_id, agent_kind,
        notification_channel, notification_priority, min_cooldown_seconds,
        execution_config
      ) VALUES (
        ${watcherId}, ${args.name ?? args.slug}, ${args.slug}, ${organizationId},
        ${`{${entityIdsArray.join(',')}}`}::bigint[],
        ${args.schedule ?? null}, ${nextRunAtVal},
        ${args.agent_id ?? null}, ${args.scheduler_client_id ?? null},
        ${sql.json(args.model_config || {})}, ${sql.json(sources)},
        1, NULL, ${toTextArrayParam(args.tags || [])}::text[],
        'active', ${createdBy}, NOW(), NOW(),
        ${watcherId},
        ${args.device_worker_id ?? null}, ${args.agent_kind ?? null},
        ${args.notification_channel ?? 'canvas'},
        ${args.notification_priority ?? 'normal'},
        ${args.min_cooldown_seconds ?? 0},
        ${toJsonParam(tx, args.execution_config)}
      )
    `;

    // 2. Create watcher_versions row (v1)
    await tx`
      INSERT INTO watcher_versions (
        id, watcher_id, version, name, description,
        prompt, version_sources,
        keying_config, classifiers,
        reactions_guidance, change_notes, created_by, created_at
      ) VALUES (
        ${versionId}, ${watcherId}, 1, ${args.name ?? args.slug}, ${args.description ?? null},
        ${args.prompt}, ${toJsonParam(tx, sources)},
        ${toJsonParam(tx, keyingConfig)}, ${toJsonParam(tx, classifiers)},
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
    viewUrl = buildWatchersUrl(toEntityInfo(organizationSlug, entityRow), baseUrl);
  }

  logger.info(`[manage_watchers] Created watcher ${watcherId} with slug '${args.slug}'`);

  if (organizationId) {
    recordLifecycleEvent({
      organizationId,
      entityType: 'watcher',
      op: 'created',
      entityId: watcherId,
      summary: `Watcher "${args.name ?? args.slug}" created`,
      extra: { slug: args.slug, agent_id: args.agent_id ?? null },
    });
  }

  return {
    action: 'create',
    watcher_id: String(watcherId),
    version: 1,
    status: 'active',
    sources,
    view_url: viewUrl,
  };
}

// ============================================
// handleUpdate
// ============================================

export async function handleUpdate(
  args: ManageWatchersArgs,
  _env: Env,
  ctx: ToolContext
): Promise<{ action: 'update'; watcher_id: string; updated_fields: string[] }> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for update action');
  }
  assertValidExecutionConfig(args.execution_config, ctx);
  // Re-pinning to a device targets that device owner's machine — validate the
  // caller may pin it (own it, or org owner/admin over an org-attached device).
  // undefined = unchanged and null = clear the pin both pass without a lookup.
  await assertDeviceWorkerAccess(sql, args.device_worker_id, ctx);

  await requireExists(sql, 'watchers', args.watcher_id, 'Watcher');

  // Validate schedule if provided
  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      return { error: scheduleError } as any;
    }
  }

  // Match the invariant from handleCreate: a watcher with no agent_id is
  // a zombie the scheduler will never run (automation joins on
  // `agent_id IS NOT NULL`). Reject explicit nulling, and reject updates
  // that would leave a scheduled watcher orphaned.
  if (args.agent_id === null) {
    throw new ToolUserError(
      'agent_id cannot be set to null — every watcher must have an owning agent.'
    );
  }
  if (args.schedule !== null && args.schedule !== undefined && args.agent_id === undefined) {
    const currentRows = await sql`
      SELECT agent_id FROM watchers WHERE id = ${args.watcher_id} LIMIT 1
    `;
    const currentAgentId = (currentRows[0] as { agent_id: string | null } | undefined)?.agent_id;
    if (currentAgentId === null) {
      throw new ToolUserError(
        'Cannot schedule a watcher with no owning agent. Assign agent_id in the same update.'
      );
    }
  }

  const updatedFields: string[] = [];
  if (args.model_config !== undefined) updatedFields.push('model_config');
  if (args.execution_config !== undefined) updatedFields.push('execution_config');
  if (args.schedule !== undefined) updatedFields.push('schedule');
  if (args.agent_id !== undefined) updatedFields.push('agent_id');
  if (args.scheduler_client_id !== undefined) updatedFields.push('scheduler_client_id');
  if (args.tags !== undefined) updatedFields.push('tags');
  if (args.device_worker_id !== undefined) updatedFields.push('device_worker_id');
  if (args.agent_kind !== undefined) updatedFields.push('agent_kind');
  if (args.notification_channel !== undefined) updatedFields.push('notification_channel');
  if (args.notification_priority !== undefined) updatedFields.push('notification_priority');
  if (args.min_cooldown_seconds !== undefined) updatedFields.push('min_cooldown_seconds');

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
      execution_config = CASE WHEN ${args.execution_config !== undefined} THEN ${toJsonParam(sql, args.execution_config)} ELSE execution_config END,
      schedule = CASE WHEN ${args.schedule !== undefined} THEN ${scheduleValue} ELSE schedule END,
      next_run_at = CASE WHEN ${args.schedule !== undefined} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END,
      agent_id = CASE WHEN ${args.agent_id !== undefined} THEN ${args.agent_id ?? null} ELSE agent_id END,
      scheduler_client_id = CASE WHEN ${args.scheduler_client_id !== undefined} THEN ${args.scheduler_client_id ?? null} ELSE scheduler_client_id END,
      tags = CASE WHEN ${args.tags !== undefined} THEN ${toTextArrayParam(args.tags || [])}::text[] ELSE tags END,
      device_worker_id = CASE WHEN ${args.device_worker_id !== undefined} THEN ${args.device_worker_id ?? null}::uuid ELSE device_worker_id END,
      agent_kind = CASE WHEN ${args.agent_kind !== undefined} THEN ${args.agent_kind ?? null} ELSE agent_kind END,
      notification_channel = CASE WHEN ${args.notification_channel !== undefined} THEN ${args.notification_channel ?? 'canvas'} ELSE notification_channel END,
      notification_priority = CASE WHEN ${args.notification_priority !== undefined} THEN ${args.notification_priority ?? 'normal'} ELSE notification_priority END,
      min_cooldown_seconds = CASE WHEN ${args.min_cooldown_seconds !== undefined} THEN ${args.min_cooldown_seconds ?? 0} ELSE min_cooldown_seconds END
    WHERE id = ${args.watcher_id}
  `;

  logger.info(`[manage_watchers] Updated watcher ${args.watcher_id}: ${updatedFields.join(', ')}`);

  return {
    action: 'update',
    watcher_id: args.watcher_id,
    updated_fields: updatedFields,
  };
}

// ============================================
// handleDelete
// ============================================

export async function handleDelete(args: ManageWatchersArgs): Promise<{
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
        if (watcher.organization_id) {
          recordLifecycleEvent({
            organizationId: watcher.organization_id as string,
            entityType: 'watcher',
            op: 'deleted',
            entityId: watcherId,
            summary: `Watcher "${watcher.name || watcherId}" archived`,
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
        message: getErrorMessage(error),
      });
    }
  }

  return {
    action: 'delete',
    results,
    summary: summarizeResults(results),
  };
}

// ============================================
// handleCreateFromVersion
// ============================================

export async function handleCreateFromVersion(
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

  // Fetch the source version + the source watcher's reaction script AND its
  // derived input schema. Reaction script + its `reaction_input_schema` contract
  // live on the watchers row, not on watcher_versions, so they have to be copied
  // explicitly when assigning the template to a new entity. Without this copy the
  // new assignment would have no reactions — or (dropping the input schema) a
  // reaction with no extraction contract, silently running free-form.
  const versionRows = await sql`
    SELECT wv.*, w.organization_id, w.schedule, w.sources, w.agent_id, w.scheduler_client_id,
           w.model_config, w.execution_config, w.tags, w.watcher_group_id,
           w.reaction_script, w.reaction_script_compiled, w.reaction_input_schema
    FROM watcher_versions wv
    JOIN watchers w ON w.id = wv.watcher_id
    WHERE wv.id = ${args.version_id}
    LIMIT 1
  `;
  if (versionRows.length === 0) throw new Error(`Version ${args.version_id} not found`);
  const version = versionRows[0];
  const organizationId = version.organization_id as string;
  if (!organizationId || organizationId !== ctx.organizationId) {
    throw new Error(
      `Access denied: watcher version ${args.version_id} does not belong to your organization`
    );
  }
  if (!version.agent_id) {
    // Source watcher has no agent — cloning would silently inherit null and
    // produce active zombies the scheduler skips. Same invariant as handleCreate.
    throw new ToolUserError(
      `Source watcher version ${args.version_id} has no agent_id; assign an agent on the source before cloning.`
    );
  }

  // Reject cross-org entity_ids before cloning: a watcher attached to another
  // org's entity links its synced/extracted content to a non-existent in-org
  // entity (silent data-correctness bug). Names are fetched org-scoped below.
  await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);

  // Fetch entity names for name pattern substitution (org-scoped)
  const entityRows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${organizationId}
      AND e.id = ANY(${`{${args.entity_ids.join(',')}}`}::bigint[])
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
        schedule, next_run_at, agent_id, scheduler_client_id, model_config, execution_config, sources, version,
        current_version_id, tags, status, created_by, created_at, updated_at,
        watcher_group_id, source_watcher_id,
        reaction_script, reaction_script_compiled, reaction_input_schema
      ) VALUES (
        ${watcherId}, ${watcherName}, ${watcherSlug}, ${organizationId},
        ${`{${entityId}}`}::bigint[],
        ${version.schedule ?? null}, ${version.schedule ? nextRunAt(version.schedule as string) : null},
        ${version.agent_id ?? null}, ${version.scheduler_client_id ?? null},
        ${toJsonParam(sql, version.model_config)}, ${toJsonParam(sql, version.execution_config)}, ${toJsonParam(sql, sources)},
        ${(version.version as number) ?? 1}, ${sharedVersionId}, ${toTextArrayParam((version.tags as string[]) || [])}::text[],
        'active', ${createdBy}, NOW(), NOW(),
        ${groupId}, ${version.watcher_id},
        ${(version.reaction_script as string | null) ?? null},
        ${(version.reaction_script_compiled as string | null) ?? null},
        ${toJsonParam(sql, version.reaction_input_schema)}
      )
    `;

    created.push({ watcher_id: String(watcherId), entity_id: entityId, name: watcherName });

    recordLifecycleEvent({
      organizationId,
      entityType: 'watcher',
      op: 'created',
      entityId: watcherId,
      summary: `Watcher "${watcherName}" created`,
      extra: { slug: watcherSlug, via: 'create_from_version' },
    });
  }

  return { action: 'create_from_version', created };
}
