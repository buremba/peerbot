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
import { assertDeviceWorkerAccess } from '../behavior-device-access';
import { assertValidExecutionConfig } from '../behavior-execution-config';
import { assertEntityIdsInOrg, getNextNumericId, requireExists } from '../helpers/db-helpers';
import type { ToolContext } from '../../registry';
import type { ManageBehaviorsArgs } from '../manage_behaviors';
import {
  normalizeBehaviorUpdatePatch,
  type BehaviorTrigger,
  type BehaviorUpdatePatch,
} from '@lobu/core/contracts/tools/manage-behaviors';
import {
  assertOutputEntityTypesExist,
  assertOutputEventTypesExist,
  assertOutputsShape,
  assertWatcherVersionConfigValid,
  assertWatcherSourcesResolve,
  assertBehaviorSkillsResolve,
  assertPromptSkillTokensPinned,
  normalizeStoredJsonField,
  parseJsonInput,
  toJsonParam,
  toTextArrayParam,
  summarizeResults,
  type WatcherOperationResult,
} from './shared';
import {
  type BehaviorExecutorDefaults,
  type BehaviorTriggerInput,
  assertBehaviorExecutorsAuthorized,
  assertBehaviorExecutorsResolve,
  resolveBehaviorExecutor,
} from './executors';
import { getErrorMessage } from '@lobu/core';
import { DEFAULT_BEHAVIOR_SOURCE_QUERY, behaviorSourcesFromPrompt, mergePromptSources } from '../../../watchers/source-refs';
import {
  compileReactionScript,
  extractReactionInputSchema,
} from '../../../watchers/reaction-executor';
import {
  assertBehaviorInstructions,
  assertBehaviorOutputsUseWindowExecution,
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
  behavior_id: string;
  version: number;
  status: string;
  sources?: Array<{ name: string; query: string }>;
  view_url?: string;
}> {
  const sql = getDb();

  // Require slug for create. Instruction text (prompt) is required only when
  // the trigger shape runs on instructions alone — event-turn Behaviors may
  // omit it and run on the built-in default (see assertBehaviorInstructions,
  // called after triggers resolve below). The output contract is not authored
  // here: declared outputs derive it from entity/event contracts at runtime;
  // a Behavior without outputs or a reaction uses the free-form summary fallback.
  if (!args.slug) {
    throw new ToolUserError('slug is required for create action');
  }
  assertValidExecutionConfig(args.execution_config, ctx);

  // entity_id is optional: omit it for an org-scoped/global watcher.
  const entityId = args.entity_id;

  // Parse JSON inputs
  const outputs = parseJsonInput<Record<string, unknown>>(args.outputs, 'outputs');
  // String inputs pass the wire union unparsed — enforce the declared shape
  // here so both input forms meet the same contract.
  assertOutputsShape(outputs);
  const classifiers = parseJsonInput<unknown[]>(args.classifiers, 'classifiers');

  // Build sources array. Sources are authored two ways and merged here:
  //   1. `@`-mention tokens in the prompt (the owletto composer's primary path)
  //      — the backend derives them so the UI sends only the raw prompt.
  //   2. explicit `args.sources` (API callers / legacy).
  // If neither yields anything, fall back to a default all-events source.
  // `create_version` deliberately does NOT derive (see version-actions.ts):
  // an existing prompt's prose must not silently re-author the Behavior's
  // source set during an otherwise unrelated version bump.
  const promptSources = behaviorSourcesFromPrompt(args.prompt ?? '');
  const explicitSources = args.sources ?? [];
  const merged = mergePromptSources(explicitSources, promptSources);
  const sources: Array<{ name: string; query: string }> =
    merged.length > 0
      ? merged
      : [
          {
            name: 'content',
            query: DEFAULT_BEHAVIOR_SOURCE_QUERY,
          },
        ];

  // Validate watcher config
  assertWatcherVersionConfigValid({
    prompt: args.prompt,
    classifiers,
    sources,
  });

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

  // Resolve every source against the org now so a broken source fails at create
  // (422) instead of producing silent empty context at read_knowledge: @refs are
  // existence-checked, and custom SQL is planned (LIMIT 0) to catch bad
  // columns/syntax. Pass the Behavior's entity_ids so {{entityId}} validates as
  // it runs.
  if (!organizationId) {
    throw new ToolUserError('Cannot resolve Behavior sources without an organization');
  }
  // Both of these are free-text columns with NO database foreign key, so an
  // unresolvable id is accepted by the INSERT and only shows up as a Behavior
  // that never runs (agent_id) or one whose output contract is silently voided
  // (outputs' entity/event targets). The executor matrix catches unresolvable
  // executors up front — every automated Behavior needs an executor;
  // manual-only Behaviors (no triggers) may be executor-less.
  const executorDefaults: BehaviorExecutorDefaults = {
    agentId: args.agent_id ?? null,
    deviceWorkerId: args.device_worker_id ?? null,
    agentKind: args.agent_kind ?? null,
  };
  // Resolve entity output targets BEFORE the row is written.
  await assertOutputEntityTypesExist(sql, organizationId, outputs);
  await assertOutputEventTypesExist(
    organizationId,
    outputs,
    entityId ? [entityId] : []
  );
  await assertWatcherSourcesResolve(
    sql,
    organizationId,
    sources,
    entityId ? [entityId] : [],
  );
  const triggerWrite = resolveBehaviorTriggerWrite({
    triggers: args.triggers,
  });
  assertBehaviorOutputsUseWindowExecution(triggerWrite.triggers, outputs);
  await assertBehaviorTriggerConnections(sql, organizationId, triggerWrite.triggers);
  // Executor matrix (after triggers resolve): every automated Behavior needs
  // an executor; manual-only Behaviors (no triggers) may be executor-less.
  assertBehaviorExecutorsResolve(
    triggerWrite.triggers as BehaviorTriggerInput[],
    executorDefaults
  );
  await assertBehaviorExecutorsAuthorized(
    sql,
    organizationId,
    executorDefaults,
    ctx
  );
  const skills = args.skills ?? [];
  assertBehaviorInstructions(triggerWrite.triggers, args.prompt, skills);
  assertPromptSkillTokensPinned(args.prompt, skills);
  // v1 constraint: skill bodies resolve against ONE agent library at save
  // time — the Behavior-level default executor when it is an agent.
  // Per-trigger responders reuse these frozen bodies at dispatch.
  const defaultExecutor = resolveBehaviorExecutor(executorDefaults);
  if (skills.length > 0) {
    if (!defaultExecutor || defaultExecutor.kind !== 'agent') {
      throw new ToolUserError(
        'skills require a Behavior-level agent executor: skills compile against the default agent’s library. Set agent_id, or remove skills for device-executed / manual-only Behaviors.',
        422
      );
    }
    await assertBehaviorSkillsResolve(sql, organizationId, defaultExecutor.agentId, skills);
  }

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
        schedule, timezone, next_run_at, triggers, agent_id, model_config, sources, version,
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
        ${args.agent_id ?? null},
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
        prompt, version_sources, skills,
        outputs, classifiers,
        reactions_guidance, change_notes, created_by, created_at
      ) VALUES (
        ${versionId}, ${watcherId}, 1, ${args.name ?? args.slug}, ${args.description ?? null},
        ${args.prompt ?? ''}, ${toJsonParam(tx, sources)}, ${tx.json(skills)},
        ${toJsonParam(tx, outputs)}, ${toJsonParam(tx, classifiers)},
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
          throw new ToolUserError('Authenticated user is required to create Behavior classifiers', 403);
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

  // The route is workspace-level, so it no longer needs an owning agent —
  // device-pinned and manual-only Behaviors get a link too.
  if (organizationSlug) {
    viewUrl = buildBehaviorUrl(organizationSlug, watcherId as number, baseUrl);
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
      resourceKind: 'behavior',
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
        device_worker_id: args.device_worker_id ?? null,
        model_config: args.model_config ?? {},
        execution_config: args.execution_config ?? null,
        sources,
        tags: args.tags ?? [],
        notification_channel: args.notification_channel ?? 'canvas',
        notification_priority: args.notification_priority ?? 'normal',
        min_cooldown_seconds: args.min_cooldown_seconds ?? 0,
        prompt: args.prompt ?? '',
        description: args.description ?? null,
        outputs: outputs ?? null,
        classifiers: classifiers ?? null,
        reactions_guidance: args.reactions_guidance ?? null,
        reaction_script: reactionScript,
        reaction_input_schema: reactionInputSchema ?? null,
      },
    });
  }

  return {
    action: 'create',
    behavior_id: String(watcherId),
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
): Promise<{ action: 'update'; behavior_id: string; updated_fields: string[] }> {
  const sql = getDb();

  if (!args.behavior_id) {
    throw new ToolUserError('behavior_id is required for update action', 400);
  }
  assertValidExecutionConfig(args.execution_config, ctx);
  // Re-pinning to a device targets that device owner's machine — validate the
  // caller may pin it (own it, or org owner/admin over an org-attached device).
  // undefined = unchanged and null = clear the pin both pass without a lookup.
  await assertDeviceWorkerAccess(sql, args.device_worker_id, ctx);

  await requireExists(sql, 'watchers', args.behavior_id, 'Behavior');
  const currentRows = await sql`
    SELECT w.organization_id, w.agent_id, w.schedule, w.timezone, w.triggers,
           w.device_worker_id::text AS device_worker_id, w.agent_kind,
           cv.prompt AS current_prompt, cv.skills AS current_skills,
           cv.outputs AS current_outputs
    FROM watchers w
    LEFT JOIN watcher_versions cv ON cv.id = w.current_version_id
    WHERE w.id = ${args.behavior_id}
    LIMIT 1
  `;
  const currentRow = currentRows[0] as {
    organization_id: string;
    agent_id: string | null;
    device_worker_id: string | null;
    agent_kind: string | null;
    schedule: string | null;
    timezone: string | null;
    triggers: ManageBehaviorsArgs['triggers'];
    current_prompt: string | null;
    current_skills: Array<{ name: string; content: string }> | null;
    current_outputs: Record<string, unknown> | null;
  };
  const triggerWrite = resolveBehaviorTriggerWrite({
    triggers: args.triggers,
    currentTriggers: currentRow.triggers ?? [],
  });
  assertBehaviorOutputsUseWindowExecution(
    triggerWrite.triggers,
    normalizeStoredJsonField(
      currentRow.current_outputs,
      undefined as Record<string, unknown> | undefined
    )
  );
  if (
    args.triggers !== undefined &&
    !behaviorTriggersEqual(currentRow.triggers ?? [], triggerWrite.triggers)
  ) {
    await assertBehaviorTriggerConnections(sql, currentRow.organization_id, triggerWrite.triggers);
    // Trigger shape alone can force the instruction rule (event-turn → schedule
    // with an empty current prompt must fail). Callers that need to change both
    // triggers and instructions atomically must use create_version with both
    // fields — lobu apply does that path.
    assertBehaviorInstructions(
      triggerWrite.triggers,
      currentRow.current_prompt,
      currentRow.current_skills
    );
  }

  // Executor matrix on the EFFECTIVE state (patch over the current row): an
  // automated Behavior needs an executor. Clearing agent_id is fine when a
  // device pin remains (device precedence), and manual-only Behaviors (no
  // triggers) may be executor-less.
  const effectiveDefaults: BehaviorExecutorDefaults = {
    agentId: args.agent_id !== undefined ? args.agent_id : currentRow.agent_id,
    deviceWorkerId:
      args.device_worker_id !== undefined
        ? args.device_worker_id
        : currentRow.device_worker_id,
    agentKind:
      args.agent_kind !== undefined ? args.agent_kind : currentRow.agent_kind,
  };
  assertBehaviorExecutorsResolve(
    triggerWrite.triggers as BehaviorTriggerInput[],
    effectiveDefaults
  );
  await assertBehaviorExecutorsAuthorized(
    sql,
    ctx.organizationId,
    effectiveDefaults,
    ctx
  );

  const updatedFields: string[] = [];
  if (args.model_config !== undefined) updatedFields.push('model_config');
  if (args.execution_config !== undefined) updatedFields.push('execution_config');
  if (args.triggers !== undefined) updatedFields.push('triggers');
  if (args.agent_id !== undefined) updatedFields.push('agent_id');
  if (args.tags !== undefined) updatedFields.push('tags');
  if (args.device_worker_id !== undefined) updatedFields.push('device_worker_id');
  if (args.agent_kind !== undefined) updatedFields.push('agent_kind');
  if (args.notification_channel !== undefined) updatedFields.push('notification_channel');
  if (args.notification_priority !== undefined) updatedFields.push('notification_priority');
  if (args.min_cooldown_seconds !== undefined) updatedFields.push('min_cooldown_seconds');

  if (updatedFields.length === 0) {
    return {
      action: 'update',
      behavior_id: args.behavior_id,
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
      tags = CASE WHEN ${has('tags')} THEN ${toTextArrayParam(patch.tags ?? [])}::text[] ELSE tags END,
      device_worker_id = CASE WHEN ${has('device_worker_id')} THEN ${patch.device_worker_id ?? null}::uuid ELSE device_worker_id END,
      agent_kind = CASE WHEN ${has('agent_kind')} THEN ${patch.agent_kind ?? null} ELSE agent_kind END,
      notification_channel = CASE WHEN ${has('notification_channel')} THEN ${patch.notification_channel ?? 'canvas'} ELSE notification_channel END,
      notification_priority = CASE WHEN ${has('notification_priority')} THEN ${patch.notification_priority ?? 'normal'} ELSE notification_priority END,
      min_cooldown_seconds = CASE WHEN ${has('min_cooldown_seconds')} THEN ${patch.min_cooldown_seconds ?? 0} ELSE min_cooldown_seconds END
    WHERE id = ${args.behavior_id} AND organization_id = ${ctx.organizationId}
    RETURNING *
  `;

  logger.info(`[manage_behaviors] Updated watcher ${args.behavior_id}: ${updatedFields.join(', ')}`);

  const updatedRow = (updatedRows[0] ?? null) as Record<string, unknown> | null;
  await syncBehaviorChannelFeedsBestEffort({
    organizationId: currentRow.organization_id,
    before: currentRow.triggers ?? [],
    after: triggerWrite.triggers,
    sql,
  });
  recordToolConfigChange(ctx, {
    organizationId: (updatedRow?.organization_id as string | null) ?? ctx.organizationId,
    resourceKind: 'behavior',
    resourceId: args.behavior_id,
    op: 'updated',
    summary: `Behavior '${updatedRow?.name ?? args.behavior_id}' updated`,
    state: updatedRow,
    changedFields: updatedFields,
  });

  return {
    action: 'update',
    behavior_id: args.behavior_id,
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

  if (!args.behavior_ids || args.behavior_ids.length === 0) {
    throw new ToolUserError('behavior_ids is required and cannot be empty', 400);
  }

  const results: WatcherOperationResult[] = [];

  for (const watcherId of args.behavior_ids) {
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
          behavior_id: watcherId,
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
            resourceKind: 'behavior',
            resourceId: watcherId,
            op: 'deleted',
            summary: `Behavior '${watcher.name || watcherId}' archived`,
            state: null,
          });
        }

        results.push({
          behavior_id: watcherId,
          success: true,
          message: 'Behavior archived successfully',
        });
      }
    } catch (error) {
      results.push({
        behavior_id: watcherId,
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
  created: Array<{ behavior_id: string; entity_id: number; name: string }>;
}> {
  const sql = getDb();

  if (!args.version_id) throw new ToolUserError('version_id is required for create_from_version', 400);
  if (!args.entity_ids || args.entity_ids.length === 0) {
    throw new ToolUserError('entity_ids is required for create_from_version', 400);
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
    SELECT wv.*, w.organization_id, w.schedule, w.timezone, w.triggers, w.sources, w.agent_id,
           w.device_worker_id::text AS device_worker_id, w.agent_kind,
           w.model_config, w.execution_config, w.tags, w.watcher_group_id,
           w.reaction_script, w.reaction_script_compiled, w.reaction_input_schema
    FROM watcher_versions wv
    JOIN watchers w ON w.id = wv.watcher_id
    WHERE wv.id = ${args.version_id}
    LIMIT 1
  `;
  if (versionRows.length === 0) throw new ToolUserError(`Version ${args.version_id} not found`, 404);
  const version = versionRows[0];
  const organizationId = version.organization_id as string;
  if (!organizationId || organizationId !== ctx.organizationId) {
    throw new Error(
      `Access denied: Behavior version ${args.version_id} does not belong to your organization`
    );
  }
  // The clone strips chat-link steer/reply triggers (a second agent turn for
  // the same message), so the matrix runs on the STRIPPED shape — an agentless
  // source whose only automated triggers were chat-link responders must be
  // allowed to clone as manual-only, and a source that strips down to nothing
  // must not land executor-less automated rows. Every automated clone needs an
  // executor; manual-only clones may be executor-less (same invariant as
  // handleCreate/handleUpdate).
  const cloneTriggers = stripChatLinkTriggers(version.triggers) as BehaviorTrigger[];
  const cloneDefaults: BehaviorExecutorDefaults = {
    agentId: (version.agent_id as string | null) ?? null,
    deviceWorkerId: (version.device_worker_id as string | null) ?? null,
    agentKind: (version.agent_kind as string | null) ?? null,
  };
  // The executor is copied verbatim onto every clone, and a version can
  // outlive the executor it names (agent_id/device_worker_id have no FK, so a
  // deleted agent/device leaves the reference dangling). Resolve + authorize
  // once here so the fan-out cannot mint a batch of Behaviors the scheduler
  // will never run — or store a device pin the caller may not target.
  assertBehaviorExecutorsResolve(cloneTriggers, cloneDefaults);
  await assertBehaviorExecutorsAuthorized(sql, organizationId, cloneDefaults, ctx);

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

  // A once-valid version can outlive a referenced table or entity type. Resolve
  // its sources before fan-out, passing each assignment's entity context so
  // `{{entityId}}` is validated the same way as at runtime.
  const clonedSources = (version.version_sources ?? version.sources ?? []) as Array<{
    name: string;
    query: string;
  }>;
  const clonedOutputs = normalizeStoredJsonField(
    version.outputs,
    undefined as Record<string, unknown> | undefined
  );
  await assertOutputEntityTypesExist(sql, organizationId, clonedOutputs);
  for (const entityId of entityIds) {
    await assertOutputEventTypesExist(organizationId, clonedOutputs, [entityId]);
  }
  if (clonedSources.length > 0) {
    for (const entityId of entityIds) {
      await assertWatcherSourcesResolve(sql, organizationId, clonedSources, [entityId]);
    }
  }

  const createdBy = ctx.userId ?? 'system';
  const created: Array<{
    behavior_id: string;
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
        if (!entity) throw new ToolUserError(`Entity ${entityId} not found`, 404);

        const namePattern = args.name_pattern ?? `${version.name}: {{entity_name}}`;
        const watcherName = namePattern.replace(/\{\{entity_name\}\}/g, entity.name as string);
        const watcherSlug = `${version.name}-${entity.slug}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-');

        const watcherId = await getNextNumericId(tx, 'watchers');
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
        // cloneTriggers is computed once above (it does not depend on entity).
        // After stripping, the residual trigger shape must still satisfy the
        // instruction rule (chat-link-only sources become manual/empty triggers
        // and require a non-empty prompt).
        // The clone SHARES the source's watcher_versions row, so its pinned
        // skills come along with it — they satisfy the rule here exactly as they
        // will at dispatch.
        assertBehaviorInstructions(
          (Array.isArray(cloneTriggers) ? cloneTriggers : []) as BehaviorTrigger[],
          version.prompt as string | null | undefined,
          version.skills as Array<{ name: string; content: string }> | null
        );
        assertBehaviorOutputsUseWindowExecution(
          (Array.isArray(cloneTriggers) ? cloneTriggers : []) as BehaviorTrigger[],
          clonedOutputs
        );
        // `tags` is a text[] column read under fetch_types:false, so postgres.js
        // hands back a raw array literal string (e.g. "{}" or "{system:chat-link}"),
        // not a JS array. Parse it before filtering.
        const cloneTags = parsePgTextArray(
          version.tags as string | string[] | null,
        ).filter((tag) => tag !== 'system:chat-link');

        await tx`
          INSERT INTO watchers (
            id, name, slug, organization_id, entity_ids,
            schedule, timezone, next_run_at, triggers, agent_id, device_worker_id, agent_kind, model_config, execution_config, sources, version,
            current_version_id, tags, status, created_by, created_at, updated_at,
            watcher_group_id, source_watcher_id,
            reaction_script, reaction_script_compiled, reaction_input_schema
          ) VALUES (
            ${watcherId}, ${watcherName}, ${watcherSlug}, ${organizationId},
            ${`{${entityId}}`}::bigint[],
            ${version.schedule ?? null}, ${version.timezone ?? null}, ${version.schedule ? nextRunAt(version.schedule as string, new Date(), version.timezone as string | null) : null}, ${toJsonParam(tx, cloneTriggers)},
            ${version.agent_id ?? null},
            ${version.device_worker_id ?? null},
            ${version.agent_kind ?? null},
            ${toJsonParam(tx, version.model_config)}, ${toJsonParam(tx, version.execution_config)}, ${toJsonParam(tx, clonedSources)},
            ${(version.version as number) ?? 1}, ${sharedVersionId}, ${toTextArrayParam(cloneTags)}::text[],
            'active', ${createdBy}, NOW(), NOW(),
            ${groupId}, ${version.watcher_id},
            ${(version.reaction_script as string | null) ?? null},
            ${(version.reaction_script_compiled as string | null) ?? null},
            ${toJsonParam(tx, version.reaction_input_schema)}
          )
        `;

        created.push({
          behavior_id: String(watcherId),
          entity_id: entityId,
          name: watcherName,
        });
        auditPayloads.push({
          entityId,
          watcherId,
          watcherName,
          watcherSlug,
          sources: clonedSources,
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
      resourceKind: 'behavior',
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
        device_worker_id: (version.device_worker_id as string | null) ?? null,
        agent_kind: (version.agent_kind as string | null) ?? null,
        version: (version.version as number) ?? 1,
        current_version_id: p.sharedVersionId,
        watcher_group_id: p.groupId,
        source_watcher_id: version.watcher_id,
        sources: p.sources,
        prompt: version.prompt ?? null,
        outputs: version.outputs ?? null,
        classifiers: version.classifiers ?? null,
        reactions_guidance: version.reactions_guidance ?? null,
      },
    });
  }

  return { action: 'create_from_version', created };
}
