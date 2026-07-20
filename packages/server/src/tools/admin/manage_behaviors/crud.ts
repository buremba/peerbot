/**
 * CRUD action handlers for manage_behaviors:
 *   create, update, delete, create_from_version
 */

import { getDb, parsePgTextArray } from '../../../db/client';
import type { Env } from '../../../index';
import { ToolUserError } from '../../../utils/errors';
import { isUniqueViolation } from '../../../utils/pg-errors';
import { nextRunAt } from '../../../utils/cron';
import { recordChangeEvent, recordLifecycleEvent } from '../../../utils/insert-event';
import { recordToolConfigChange } from '../helpers/config-audit';
import logger from '../../../utils/logger';
import { buildBehaviorUrl, getOrganizationSlug, getPublicWebUrl } from '../../../utils/url-builder';
import {
  createClassifiersForWatcher,
  enableClassifiersOnEntity,
} from '../../../watchers/classifier-extraction';
import { assertDeviceWorkerAccess } from '../watcher-device-access';
import { assertValidExecutionConfig } from '../watcher-execution-config';
import { assertEntityIdsInOrg, getNextNumericId, requireExists } from '../helpers/db-helpers';
import type { ToolContext } from '../../registry';
import type { ManageBehaviorsArgs } from '../manage_behaviors';
import {
  normalizeBehaviorUpdatePatch,
  type BehaviorTrigger,
  type BehaviorUpdatePatch,
} from '@lobu/core/contracts/tools/manage-behaviors';
import {
  assertWatcherVersionConfigValid,
  assertWatcherSourcesResolve,
  parseJsonInput,
  toJsonParam,
  toTextArrayParam,
  summarizeResults,
  type WatcherOperationResult,
} from './shared';
import { getErrorMessage } from '@lobu/core';
import { extractSourcesFromPromptTokens, mergePromptSources } from '../../../watchers/source-refs';
import {
  compileReactionScript,
  extractReactionInputSchema,
} from '../../../watchers/reaction-executor';
import {
  assertBehaviorTriggerConnections,
  behaviorTriggersEqual,
  resolveBehaviorTriggerWrite,
} from '../../../behaviors/triggers';
import {
  syncBehaviorChannelFeeds,
  syncBehaviorChannelFeedsBestEffort,
} from '../../../behaviors/channel-subscriptions';

/**
 * Drop chat-link style triggers when cloning a Behavior onto an entity.
 * Steer + reply_to_source on message.created is the live channel responder
 * contract; copying it would double-reply in linked channels.
 */
function stripChatLinkTriggers(triggers: unknown): unknown {
  if (!Array.isArray(triggers)) return triggers ?? [];
  return triggers.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return true;
    const t = candidate as Record<string, unknown>;
    if (t.kind !== 'event') return true;
    const eventTypes = t.event_types;
    if (!Array.isArray(eventTypes) || !eventTypes.includes('message.created')) {
      return true;
    }
    if (t.active_run === 'steer' && t.output === 'reply_to_source') {
      return false;
    }
    return true;
  });
}

// ============================================
// handleCreate
// ============================================

export async function handleCreate(
  args: ManageBehaviorsArgs,
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
      : [
          {
            name: 'content',
            query: 'SELECT * FROM events ORDER BY occurred_at DESC',
          },
        ];

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
    // because the field is shared across all manage_behaviors actions, but
    // create enforces it: a watcher with no owning agent is a zombie row.
    throw new ToolUserError(
      'agent_id is required to create a Behavior (the agent that executes it).'
    );
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
        'entity_id or an organization context is required to create a Behavior'
      );
    }
    organizationSlug = await getOrganizationSlug(organizationId);
  }

  // Resolve @ref sources against the org now so a typo fails at create (422)
  // instead of producing silent empty context at read_knowledge. Custom-SQL
  // sources are skipped here; their id projection is enforced above.
  if (!organizationId) {
    throw new ToolUserError('Cannot resolve Behavior sources without an organization');
  }
  await assertWatcherSourcesResolve(sql, organizationId, sources);
  const triggerWrite = resolveBehaviorTriggerWrite({
    triggers: args.triggers,
  });
  await assertBehaviorTriggerConnections(sql, organizationId, triggerWrite.triggers);

  // Check slug uniqueness within org
  const existingSlug = await sql`
    SELECT id FROM watchers
    WHERE organization_id = ${organizationId} AND slug = ${args.slug}
    LIMIT 1
  `;
  if (existingSlug.length > 0) {
    throw new ToolUserError(
      `Behavior with slug '${args.slug}' already exists in this organization`,
      409
    );
  }

  const reactionScript = args.reaction_script?.trim() ? args.reaction_script : null;
  const reactionScriptCompiled = reactionScript
    ? await compileReactionScript(reactionScript)
    : null;
  const reactionInputSchema = reactionScript
    ? await extractReactionInputSchema(reactionScript)
    : null;

  const createdBy = ctx.userId ?? 'system';

  // Allocated inside the transaction below: getNextNumericId relies on
  // pg_advisory_xact_lock, which only serializes when a real transaction is
  // open. Called on the pooled autocommit connection it releases immediately,
  // so concurrent creates would both compute MAX(id)+1 and collide on the PK.
  let watcherId!: number;
  let versionId!: number;

  try {
    await sql.begin(async (tx) => {
      watcherId = await getNextNumericId(tx, 'watchers');
      versionId = await getNextNumericId(tx, 'watcher_versions');
      const entityIdsArray = entityId ? [entityId] : [];

      const nextRunAtVal = triggerWrite.schedule
        ? nextRunAt(triggerWrite.schedule, new Date(), triggerWrite.timezone)
        : null;

      // 1. Create watcher row
      await tx`
      INSERT INTO watchers (
        id, name, slug, organization_id, entity_ids,
        schedule, timezone, next_run_at, triggers, agent_id, scheduler_client_id, model_config, sources, version,
        current_version_id, tags, status, created_by, created_at, updated_at,
        watcher_group_id,
        device_worker_id, agent_kind,
        notification_channel, notification_priority, min_cooldown_seconds,
        execution_config,
        reaction_script, reaction_script_compiled, reaction_input_schema
      ) VALUES (
        ${watcherId}, ${args.name ?? args.slug}, ${args.slug}, ${organizationId},
        ${`{${entityIdsArray.join(',')}}`}::bigint[],
        ${triggerWrite.schedule}, ${triggerWrite.timezone}, ${nextRunAtVal}, ${tx.json(triggerWrite.triggers)},
        ${args.agent_id ?? null}, ${args.scheduler_client_id ?? null},
        ${sql.json(args.model_config || {})}, ${sql.json(sources)},
        1, NULL, ${toTextArrayParam(args.tags || [])}::text[],
        'active', ${createdBy}, NOW(), NOW(),
        ${watcherId},
        ${args.device_worker_id ?? null}, ${args.agent_kind ?? null},
        ${args.notification_channel ?? 'canvas'},
        ${args.notification_priority ?? 'normal'},
        ${args.min_cooldown_seconds ?? 0},
        ${toJsonParam(tx, args.execution_config)},
        ${reactionScript}, ${reactionScriptCompiled},
        ${reactionInputSchema ? tx.json(reactionInputSchema) : null}
      )
    `;

      // 2. Create watcher_versions row (v1)
      // Reaction fields (reaction_script/reaction_script_compiled/
      // reaction_input_schema) intentionally live on the watchers row only, not
      // on watcher_versions. Reactions are group-shared and unversioned (see
      // handleCreateFromVersion, which copies them off watchers, and
      // handleSetReactionScript, which writes them group-wide). Don't add them
      // here: watcher_versions has no such columns.
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
          throw new Error('Authenticated user is required to create Behavior classifiers');
        }

        await createClassifiersForWatcher(tx, watcherId as number, entityId, classifiers as any[], {
          createdBy: ctx.userId,
          organizationId: ctx.organizationId,
        });

        const slugs = (classifiers as any[]).map((d: any) => d.slug);
        await enableClassifiersOnEntity(tx, entityId, slugs);
      }
    });
  } catch (err) {
    // The slug precheck above is not a lock: two concurrent replicas can both
    // pass it and race idx_watchers_org_slug. Translate that 23505 to the SAME
    // coded 409 the precheck emits so callers see one stable duplicate signal.
    if (isUniqueViolation(err, 'idx_watchers_org_slug')) {
      throw new ToolUserError(
        `Behavior with slug '${args.slug}' already exists in this organization`,
        409
      );
    }
    throw err;
  }

  // Build view URL
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  let viewUrl: string | undefined;

  if (organizationSlug && args.agent_id) {
    viewUrl = buildBehaviorUrl(organizationSlug, args.agent_id, watcherId as number, baseUrl);
  }

  logger.info(`[manage_behaviors] Created watcher ${watcherId} with slug '${args.slug}'`);

  await syncBehaviorChannelFeedsBestEffort({
    organizationId,
    after: triggerWrite.triggers,
    sql,
  });

  if (organizationId) {
    recordLifecycleEvent({
      organizationId,
      entityType: 'watcher',
      op: 'created',
      entityId: watcherId,
      summary: `Behavior "${args.name ?? args.slug}" created`,
      extra: { slug: args.slug, agent_id: args.agent_id ?? null },
    });

    recordToolConfigChange(ctx, {
      organizationId,
      resourceKind: 'watcher',
      resourceId: watcherId,
      op: 'created',
      summary: `Behavior '${args.name ?? args.slug}' created`,
      // Post-insert state composed from the inserted values (the row is not
      // refetched); includes the v1 version-bound fields (prompt, sources, …).
      state: {
        id: watcherId,
        name: args.name ?? args.slug,
        slug: args.slug,
        status: 'active',
        version: 1,
        current_version_id: versionId,
        entity_ids: entityId ? [entityId] : [],
        schedule: triggerWrite.schedule,
        timezone: triggerWrite.timezone,
        triggers: triggerWrite.triggers,
        agent_id: args.agent_id ?? null,
        agent_kind: args.agent_kind ?? null,
        scheduler_client_id: args.scheduler_client_id ?? null,
        device_worker_id: args.device_worker_id ?? null,
        model_config: args.model_config ?? {},
        execution_config: args.execution_config ?? null,
        sources,
        tags: args.tags ?? [],
        notification_channel: args.notification_channel ?? 'canvas',
        notification_priority: args.notification_priority ?? 'normal',
        min_cooldown_seconds: args.min_cooldown_seconds ?? 0,
        prompt: args.prompt,
        description: args.description ?? null,
        keying_config: keyingConfig ?? null,
        classifiers: classifiers ?? null,
        reactions_guidance: args.reactions_guidance ?? null,
        reaction_script: reactionScript,
        reaction_input_schema: reactionInputSchema ?? null,
      },
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
  args: ManageBehaviorsArgs,
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

  await requireExists(sql, 'watchers', args.watcher_id, 'Behavior');
  const currentRows = await sql`
    SELECT organization_id, agent_id, schedule, timezone, triggers
    FROM watchers
    WHERE id = ${args.watcher_id}
    LIMIT 1
  `;
  const currentRow = currentRows[0] as {
    organization_id: string;
    agent_id: string | null;
    schedule: string | null;
    timezone: string | null;
    triggers: ManageBehaviorsArgs['triggers'];
  };
  const triggerWrite = resolveBehaviorTriggerWrite({
    triggers: args.triggers,
    currentTriggers: currentRow.triggers ?? [],
  });
  if (
    args.triggers !== undefined &&
    !behaviorTriggersEqual(currentRow.triggers ?? [], triggerWrite.triggers)
  ) {
    await assertBehaviorTriggerConnections(sql, currentRow.organization_id, triggerWrite.triggers);
  }

  // Match the invariant from handleCreate: a watcher with no agent_id is
  // a zombie the scheduler will never run (automation joins on
  // `agent_id IS NOT NULL`). Reject explicit nulling, and reject updates
  // that would leave a scheduled watcher orphaned.
  if (args.agent_id === null) {
    throw new ToolUserError(
      'agent_id cannot be set to null — every Behavior must have an owning agent.'
    );
  }
  if (args.triggers !== undefined && triggerWrite.schedule && args.agent_id === undefined) {
    const currentAgentId = currentRow.agent_id;
    if (currentAgentId === null) {
      throw new ToolUserError(
        'Cannot schedule a Behavior with no owning agent. Assign agent_id in the same update.'
      );
    }
  }

  const updatedFields: string[] = [];
  if (args.model_config !== undefined) updatedFields.push('model_config');
  if (args.execution_config !== undefined) updatedFields.push('execution_config');
  if (args.triggers !== undefined) updatedFields.push('triggers');
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

  // Single source of truth for the stored write-normalization — the SAME
  // function feeds the config-approval review's `proposedAfter`, so what the
  // reviewer saw is byte-for-byte what this UPDATE writes (displayed == applied,
  // drift-impossible). `field in patch` reproduces the prior `args.field !==
  // undefined` guard: normalize only emits keys present in args.
  const patch = normalizeBehaviorUpdatePatch(args);
  if (args.triggers !== undefined) {
    patch.triggers = triggerWrite.triggers;
  }
  const has = (k: keyof BehaviorUpdatePatch) => k in patch;
  // Recompute next_run_at when the cadence OR its zone changes; the effective
  // pair mixes the incoming args with the stored row for whichever side was
  // omitted, so a timezone-only update re-anchors the pending firing.
  const touchesCadence = args.triggers !== undefined;
  const effectiveSchedule = touchesCadence ? triggerWrite.schedule : currentRow.schedule;
  const effectiveTimezone = touchesCadence ? triggerWrite.timezone : currentRow.timezone;
  const nextRunAtVal =
    touchesCadence && effectiveSchedule
      ? nextRunAt(effectiveSchedule, new Date(), effectiveTimezone)
      : null;

  const updatedRows = await sql`
    UPDATE watchers SET
      updated_at = NOW(),
      model_config = CASE WHEN ${has('model_config')} THEN ${toJsonParam(sql, patch.model_config)} ELSE model_config END,
      execution_config = CASE WHEN ${has('execution_config')} THEN ${toJsonParam(sql, patch.execution_config)} ELSE execution_config END,
      schedule = CASE WHEN ${touchesCadence} THEN ${triggerWrite.schedule ?? null} ELSE schedule END,
      timezone = CASE WHEN ${touchesCadence} THEN ${triggerWrite.timezone ?? null} ELSE timezone END,
      triggers = CASE WHEN ${has('triggers')} THEN ${toJsonParam(sql, patch.triggers)} ELSE triggers END,
      next_run_at = CASE WHEN ${touchesCadence} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END,
      agent_id = CASE WHEN ${has('agent_id')} THEN ${patch.agent_id ?? null} ELSE agent_id END,
      scheduler_client_id = CASE WHEN ${has('scheduler_client_id')} THEN ${patch.scheduler_client_id ?? null} ELSE scheduler_client_id END,
      tags = CASE WHEN ${has('tags')} THEN ${toTextArrayParam(patch.tags ?? [])}::text[] ELSE tags END,
      device_worker_id = CASE WHEN ${has('device_worker_id')} THEN ${patch.device_worker_id ?? null}::uuid ELSE device_worker_id END,
      agent_kind = CASE WHEN ${has('agent_kind')} THEN ${patch.agent_kind ?? null} ELSE agent_kind END,
      notification_channel = CASE WHEN ${has('notification_channel')} THEN ${patch.notification_channel ?? 'canvas'} ELSE notification_channel END,
      notification_priority = CASE WHEN ${has('notification_priority')} THEN ${patch.notification_priority ?? 'normal'} ELSE notification_priority END,
      min_cooldown_seconds = CASE WHEN ${has('min_cooldown_seconds')} THEN ${patch.min_cooldown_seconds ?? 0} ELSE min_cooldown_seconds END
    WHERE id = ${args.watcher_id} AND organization_id = ${ctx.organizationId}
    RETURNING *
  `;

  logger.info(`[manage_behaviors] Updated watcher ${args.watcher_id}: ${updatedFields.join(', ')}`);

  const updatedRow = (updatedRows[0] ?? null) as Record<string, unknown> | null;
  await syncBehaviorChannelFeedsBestEffort({
    organizationId: currentRow.organization_id,
    before: currentRow.triggers ?? [],
    after: triggerWrite.triggers,
    sql,
  });
  recordToolConfigChange(ctx, {
    organizationId: (updatedRow?.organization_id as string | null) ?? ctx.organizationId,
    resourceKind: 'watcher',
    resourceId: args.watcher_id,
    op: 'updated',
    summary: `Behavior '${updatedRow?.name ?? args.watcher_id}' updated`,
    state: updatedRow,
    changedFields: updatedFields,
  });

  return {
    action: 'update',
    watcher_id: args.watcher_id,
    updated_fields: updatedFields,
  };
}

// ============================================
// handleDelete
// ============================================

export async function handleDelete(
  args: ManageBehaviorsArgs,
  ctx: ToolContext
): Promise<{
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
      // Org-scope the mutation: requireWatcherAccess now lets ids that aren't
      // in-org at check time fall through to this aggregate, and watcher ids are
      // sequential integers — so a racing cross-tenant insert between check and
      // write must not be archivable. organization_id fences that TOCTOU.
      const updated = await sql`
        UPDATE watchers
        SET status = 'archived', updated_at = NOW()
        WHERE id = ${watcherId}
          AND organization_id = ${ctx.organizationId}
          AND status != 'archived'
        RETURNING id, name, entity_ids, organization_id, triggers
      `;

      if (updated.length === 0) {
        results.push({
          watcher_id: watcherId,
          success: false,
          message: 'Behavior not found or already archived',
        });
      } else {
        const watcher = updated[0];
        const entityIds = Array.isArray(watcher.entity_ids) ? watcher.entity_ids : [];

        // Record change event in knowledge for audit trail
        if (entityIds.length > 0 && watcher.organization_id) {
          recordChangeEvent({
            entityIds: entityIds.map(Number),
            organizationId: watcher.organization_id as string,
            title: `Behavior archived: ${watcher.name || watcherId}`,
            content: `Behavior "${watcher.name || watcherId}" (id: ${watcherId}) was archived.`,
            metadata: {
              action: 'watcher_archived',
              watcher_id: watcherId,
              watcher_name: watcher.name,
            },
          });
        }
        if (watcher.organization_id) {
          await syncBehaviorChannelFeedsBestEffort({
            organizationId: watcher.organization_id as string,
            before: (watcher.triggers ?? []) as ManageBehaviorsArgs['triggers'],
            sql,
          });
          recordLifecycleEvent({
            organizationId: watcher.organization_id as string,
            entityType: 'watcher',
            op: 'deleted',
            entityId: watcherId,
            summary: `Behavior "${watcher.name || watcherId}" archived`,
          });

          recordToolConfigChange(ctx, {
            organizationId: watcher.organization_id as string,
            resourceKind: 'watcher',
            resourceId: watcherId,
            op: 'deleted',
            summary: `Behavior '${watcher.name || watcherId}' archived`,
            state: null,
          });
        }

        results.push({
          watcher_id: watcherId,
          success: true,
          message: 'Behavior archived successfully',
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
  args: ManageBehaviorsArgs,
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
  // Bind the narrowed value: the transaction closure below re-widens
  // `args.entity_ids` back to `number[] | undefined`, losing this guard.
  const entityIds = args.entity_ids;

  // Fetch the source version + the source watcher's reaction script AND its
  // derived input schema. Reaction script + its `reaction_input_schema` contract
  // live on the watchers row, not on watcher_versions, so they have to be copied
  // explicitly when assigning the template to a new entity. Without this copy the
  // new assignment would have no reactions — or (dropping the input schema) a
  // reaction with no extraction contract, silently running free-form.
  const versionRows = await sql`
    SELECT wv.*, w.organization_id, w.schedule, w.timezone, w.triggers, w.sources, w.agent_id, w.scheduler_client_id,
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
      `Access denied: Behavior version ${args.version_id} does not belong to your organization`
    );
  }
  if (!version.agent_id) {
    // Source watcher has no agent — cloning would silently inherit null and
    // produce active zombies the scheduler skips. Same invariant as handleCreate.
    throw new ToolUserError(
      `Source Behavior version ${args.version_id} has no agent_id; assign an agent on the source before cloning.`
    );
  }

  // Reject cross-org entity_ids before cloning: a watcher attached to another
  // org's entity links its synced/extracted content to a non-existent in-org
  // entity (silent data-correctness bug). Names are fetched org-scoped below.
  await assertEntityIdsInOrg(sql, organizationId, entityIds);

  // Fetch entity names for name pattern substitution (org-scoped)
  const entityRows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${organizationId}
      AND e.id = ANY(${`{${entityIds.join(',')}}`}::bigint[])
  `;
  const entityMap = new Map(entityRows.map((e: any) => [Number(e.id), e]));

  const createdBy = ctx.userId ?? 'system';
  const created: Array<{
    watcher_id: string;
    entity_id: number;
    name: string;
  }> = [];
  // Audit/lifecycle payloads are collected inside the transaction and emitted
  // only after it commits — a rollback must not leak "created" events for
  // watchers that never landed (events is append-only; we can't take them back).
  const auditPayloads: Array<{
    entityId: number;
    watcherId: number;
    watcherName: string;
    watcherSlug: string;
    sources: unknown;
    sharedVersionId: number;
    groupId: number;
  }> = [];

  // The whole fan-out runs in ONE transaction. Two reasons:
  //  1. getNextNumericId relies on pg_advisory_xact_lock, which only serializes
  //     when a real transaction is open. On the pooled autocommit connection the
  //     lock releases immediately, so concurrent assignments would both compute
  //     MAX(id)+1 and collide on the watchers PK.
  //  2. Atomicity: a mid-loop failure (e.g. a slug clash on the 3rd entity)
  //     would otherwise leave a partial fan-out — some assignments created,
  //     some not. All-or-nothing is the correct contract here.
  try {
    await sql.begin(async (tx) => {
      for (const entityId of entityIds) {
        const entity = entityMap.get(entityId);
        if (!entity) throw new Error(`Entity ${entityId} not found`);

        const namePattern = args.name_pattern ?? `${version.name}: {{entity_name}}`;
        const watcherName = namePattern.replace(/\{\{entity_name\}\}/g, entity.name as string);
        const watcherSlug = `${version.name}-${entity.slug}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-');

        const watcherId = await getNextNumericId(tx, 'watchers');
        const sources = version.version_sources ?? version.sources ?? [];
        // The new assignment shares the source's existing watcher_versions row
        // rather than getting its own duplicate copy. version_id (the arg) is
        // the row in watcher_versions we're cloning from; that becomes the
        // assignment's current_version_id directly. The version row itself is
        // owned by the group root (watcher_group_id), so all assignments in
        // the group point at the same chain.
        const sharedVersionId = Number(args.version_id);
        const groupId = (version.watcher_group_id ?? version.watcher_id) as number;
        // Entity clones must not inherit chat-link steer/reply triggers (or the
        // system:chat-link tag): those bind a live channel responder, and
        // cloning them would create a second agent turn for the same message.
        const cloneTriggers = stripChatLinkTriggers(version.triggers);
        // `tags` is a text[] column read under fetch_types:false, so postgres.js
        // hands back a raw array literal string (e.g. "{}" or "{system:chat-link}"),
        // not a JS array. Parse it before filtering.
        const cloneTags = parsePgTextArray(
          version.tags as string | string[] | null,
        ).filter((tag) => tag !== 'system:chat-link');

        await tx`
          INSERT INTO watchers (
            id, name, slug, organization_id, entity_ids,
            schedule, timezone, next_run_at, triggers, agent_id, scheduler_client_id, model_config, execution_config, sources, version,
            current_version_id, tags, status, created_by, created_at, updated_at,
            watcher_group_id, source_watcher_id,
            reaction_script, reaction_script_compiled, reaction_input_schema
          ) VALUES (
            ${watcherId}, ${watcherName}, ${watcherSlug}, ${organizationId},
            ${`{${entityId}}`}::bigint[],
            ${version.schedule ?? null}, ${version.timezone ?? null}, ${version.schedule ? nextRunAt(version.schedule as string, new Date(), version.timezone as string | null) : null}, ${toJsonParam(tx, cloneTriggers)},
            ${version.agent_id ?? null}, ${version.scheduler_client_id ?? null},
            ${toJsonParam(tx, version.model_config)}, ${toJsonParam(tx, version.execution_config)}, ${toJsonParam(tx, sources)},
            ${(version.version as number) ?? 1}, ${sharedVersionId}, ${toTextArrayParam(cloneTags)}::text[],
            'active', ${createdBy}, NOW(), NOW(),
            ${groupId}, ${version.watcher_id},
            ${(version.reaction_script as string | null) ?? null},
            ${(version.reaction_script_compiled as string | null) ?? null},
            ${toJsonParam(tx, version.reaction_input_schema)}
          )
        `;

        created.push({
          watcher_id: String(watcherId),
          entity_id: entityId,
          name: watcherName,
        });
        auditPayloads.push({
          entityId,
          watcherId,
          watcherName,
          watcherSlug,
          sources,
          sharedVersionId,
          groupId,
        });
        // This runs inside the clone transaction, so projection failure must
        // roll the clone back with it.
        await syncBehaviorChannelFeeds({
          organizationId,
          after: Array.isArray(cloneTriggers)
            ? (cloneTriggers as BehaviorTrigger[])
            : [],
          sql: tx,
        });
      }
    });
  } catch (err) {
    // The derived slug is not pre-checked and is not locked: two concurrent
    // assignments (or a re-run) can produce the same slug and race
    // idx_watchers_org_slug. Surface a coded 409 instead of leaking a raw 23505.
    if (isUniqueViolation(err, 'idx_watchers_org_slug')) {
      throw new ToolUserError(
        `A Behavior assignment with a colliding slug already exists in this organization`,
        409
      );
    }
    throw err;
  }

  // Post-commit: emit lifecycle + audit events now that the rows are durable.
  for (const p of auditPayloads) {
    recordLifecycleEvent({
      organizationId,
      entityType: 'watcher',
      op: 'created',
      entityId: p.watcherId,
      summary: `Behavior "${p.watcherName}" created`,
      extra: { slug: p.watcherSlug, via: 'create_from_version' },
    });

    recordToolConfigChange(ctx, {
      organizationId,
      resourceKind: 'watcher',
      resourceId: p.watcherId,
      op: 'created',
      summary: `Behavior '${p.watcherName}' created from version ${args.version_id}`,
      // Composed from the cloned insert values (row not refetched); the
      // version-bound fields come from the shared source version row.
      state: {
        id: p.watcherId,
        name: p.watcherName,
        slug: p.watcherSlug,
        status: 'active',
        entity_ids: [p.entityId],
        schedule: version.schedule ?? null,
        timezone: version.timezone ?? null,
        triggers: version.triggers ?? [],
        agent_id: version.agent_id ?? null,
        scheduler_client_id: version.scheduler_client_id ?? null,
        version: (version.version as number) ?? 1,
        current_version_id: p.sharedVersionId,
        watcher_group_id: p.groupId,
        source_watcher_id: version.watcher_id,
        sources: p.sources,
        prompt: version.prompt ?? null,
        keying_config: version.keying_config ?? null,
        classifiers: version.classifiers ?? null,
        reactions_guidance: version.reactions_guidance ?? null,
      },
    });
  }

  return { action: 'create_from_version', created };
}
