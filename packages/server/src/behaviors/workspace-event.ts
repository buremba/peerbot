import type { BehaviorWorkspaceEventTrigger } from '@lobu/core/contracts/tools/manage-behaviors';
import type { DbClient } from '../db/client';
import { getDb, parsePgNumberArray, pgBigintArray } from '../db/client';
import { createBehaviorEventRun } from '../runs/queue-service';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import { resolveBehaviorExecutor } from '../tools/admin/manage_behaviors/executors';
import logger from '../utils/logger';
import { dispatchBehaviorRunsBestEffort } from './activation';
import {
  MAX_WORKSPACE_EVENT_DEPTH,
  MAX_WORKSPACE_EVENT_FANOUT,
  MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS,
  MAX_WORKSPACE_EVENT_ROOTS,
  type WorkspaceEventActivationTaskPayload,
  type WorkspaceEventTriggerSignal,
} from './workspace-event-contract';

export const WORKSPACE_EVENT_ACTIVATION_TASK = 'activate-workspace-event';

interface WorkspaceEventRecord {
  id: number;
  semanticType: string;
  metadata: Record<string, unknown>;
  entityIds: number[];
  entityTypeSlugs: string[];
  occurredAt: string;
  producerBehaviorId: number;
}

interface MatchingWorkspaceEventActivation {
  behaviorId: number;
  organizationId: string;
  agentId: string | null;
  deviceWorkerId: string | null;
  agentKind: string | null;
  trigger: BehaviorWorkspaceEventTrigger;
}

export async function enqueueWorkspaceEventActivations(
  tx: DbClient,
  payloads: WorkspaceEventActivationTaskPayload[]
): Promise<string[]> {
  return enqueueTasksInTransaction(
    tx,
    payloads.map((payload) => ({
      name: WORKSPACE_EVENT_ACTIVATION_TASK,
      payload,
      opts: {
        idempotencyKey: `workspace-event-activation:${payload.eventId}`,
        maxAttempts: 5,
        organizationId: payload.organizationId,
      },
    }))
  );
}

export function matchesWorkspaceEventTrigger(
  trigger: BehaviorWorkspaceEventTrigger,
  event: Pick<
    WorkspaceEventRecord,
    'semanticType' | 'metadata' | 'entityTypeSlugs'
  >
): boolean {
  if (!trigger.event_types.includes(event.semanticType)) return false;
  if (
    trigger.entity_type !== undefined &&
    !event.entityTypeSlugs.includes(trigger.entity_type)
  ) {
    return false;
  }
  return Object.entries(trigger.match ?? {}).every(
    ([key, expected]) => event.metadata[key] === expected
  );
}

async function loadWorkspaceEvent(
  organizationId: string,
  eventId: number,
  db: DbClient
): Promise<WorkspaceEventRecord> {
  const rows = await db<{
    id: number;
    semantic_type: string;
    metadata: Record<string, unknown> | null;
    entity_ids: unknown;
    occurred_at: string;
    behavior_id: number | null;
  }>`
    SELECT id, semantic_type, metadata, entity_ids,
           COALESCE(occurred_at, created_at)::text AS occurred_at,
           behavior_id
    FROM events
    WHERE id = ${eventId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`Workspace event ${eventId} was not found`);
  if (row.behavior_id == null) {
    throw new Error(
      `Workspace event ${eventId} is not a declared Behavior output`
    );
  }
  const entityIds = parsePgNumberArray(row.entity_ids);
  const entityTypes =
    entityIds.length > 0
      ? await db<{ slug: string }>`
        SELECT DISTINCT et.slug
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${organizationId}
          AND e.id = ANY(${pgBigintArray(entityIds)}::bigint[])
          AND e.deleted_at IS NULL
          AND et.deleted_at IS NULL
        ORDER BY et.slug
      `
      : [];
  return {
    id: Number(row.id),
    semanticType: String(row.semantic_type),
    metadata:
      row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    entityIds,
    entityTypeSlugs: entityTypes.map((item) => String(item.slug)),
    occurredAt: new Date(row.occurred_at).toISOString(),
    producerBehaviorId: Number(row.behavior_id),
  };
}

async function findMatchingWorkspaceEventActivations(
  organizationId: string,
  signal: WorkspaceEventTriggerSignal,
  event: WorkspaceEventRecord,
  db: DbClient = getDb()
): Promise<{
  matches: MatchingWorkspaceEventActivation[];
  fanoutLimited: boolean;
}> {
  const needle = [
    {
      kind: 'event',
      source: 'workspace',
      event_types: [signal.event_type],
    },
  ];
  const rows = await db`
    SELECT w.id, w.organization_id, w.agent_id, w.entity_ids,
           w.device_worker_id::text AS device_worker_id,
           w.agent_kind, w.triggers
    FROM watchers w
    WHERE w.organization_id = ${organizationId}
      AND w.status = 'active'
      AND w.current_version_id IS NOT NULL
      AND (w.agent_id IS NOT NULL OR w.device_worker_id IS NOT NULL)
      AND w.triggers @> ${db.json(needle)}::jsonb
    ORDER BY w.id ASC
  `;

  const matches: MatchingWorkspaceEventActivation[] = [];
  let fanoutLimited = false;
  for (const row of rows) {
    const behaviorId = Number(row.id);
    if (signal.causal_behavior_ids.includes(behaviorId)) continue;
    const boundEntityIds = parsePgNumberArray(row.entity_ids);
    if (
      boundEntityIds.length > 0 &&
      !boundEntityIds.some((entityId) => event.entityIds.includes(entityId))
    ) {
      continue;
    }
    const triggers = Array.isArray(row.triggers)
      ? (row.triggers as BehaviorWorkspaceEventTrigger[])
      : [];
    const trigger = triggers.find(
      (candidate) =>
        candidate.kind === 'event' &&
        candidate.source === 'workspace' &&
        matchesWorkspaceEventTrigger(candidate, event)
    );
    if (!trigger) continue;
    const executor = resolveBehaviorExecutor({
      agentId: row.agent_id as string | null,
      deviceWorkerId:
        typeof row.device_worker_id === 'string' ? row.device_worker_id : null,
      agentKind: typeof row.agent_kind === 'string' ? row.agent_kind : null,
    });
    if (!executor) continue;
    if (matches.length >= MAX_WORKSPACE_EVENT_FANOUT) {
      fanoutLimited = true;
      logger.warn(
        {
          eventId: signal.event_id,
          maxFanout: MAX_WORKSPACE_EVENT_FANOUT,
        },
        '[workspace-event] fan-out limit reached; remaining matching Behaviors skipped'
      );
      break;
    }
    matches.push({
      behaviorId,
      organizationId: String(row.organization_id),
      agentId: executor.kind === 'agent' ? executor.agentId : null,
      deviceWorkerId:
        executor.kind === 'device' ? executor.deviceWorkerId : null,
      agentKind: executor.kind === 'device' ? executor.agentKind : null,
      trigger,
    });
  }
  return { matches, fanoutLimited };
}

export async function activateWorkspaceEventTask(
  payload: WorkspaceEventActivationTaskPayload,
  db: DbClient = getDb()
): Promise<{
  matched: number;
  queued: number;
  depthLimited: boolean;
  causalBreadthLimited: boolean;
  fanoutLimited: boolean;
}> {
  const causalBehaviorIds = payload.causalBehaviorIds.filter(
    (value) => Number.isSafeInteger(value) && value > 0
  );
  if (
    !payload.organizationId ||
    !Number.isSafeInteger(payload.eventId) ||
    payload.eventId <= 0 ||
    !Array.isArray(payload.rootEventIds) ||
    payload.rootEventIds.length === 0 ||
    payload.rootEventIds.length > MAX_WORKSPACE_EVENT_ROOTS ||
    payload.rootEventIds.some(
      (eventId) => !Number.isSafeInteger(eventId) || eventId <= 0
    ) ||
    new Set(payload.rootEventIds).size !== payload.rootEventIds.length ||
    !Number.isSafeInteger(payload.depth) ||
    payload.depth < 1 ||
    causalBehaviorIds.length > MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS ||
    new Set(causalBehaviorIds).size !== causalBehaviorIds.length
  ) {
    throw new Error('Invalid workspace event activation task payload');
  }
  const event = await loadWorkspaceEvent(
    payload.organizationId,
    payload.eventId,
    db
  );
  if (causalBehaviorIds.at(-1) !== event.producerBehaviorId) {
    throw new Error(
      `Workspace event ${payload.eventId} producer does not match its causal path`
    );
  }
  if (payload.depth >= MAX_WORKSPACE_EVENT_DEPTH) {
    logger.warn(
      { eventId: payload.eventId, depth: payload.depth },
      '[workspace-event] causal depth limit reached; no downstream Behaviors queued'
    );
    return {
      matched: 0,
      queued: 0,
      depthLimited: true,
      causalBreadthLimited: false,
      fanoutLimited: false,
    };
  }
  if (causalBehaviorIds.length >= MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS) {
    logger.warn(
      { eventId: payload.eventId, causalBehaviors: causalBehaviorIds.length },
      '[workspace-event] causal breadth limit reached; no downstream Behaviors queued'
    );
    return {
      matched: 0,
      queued: 0,
      depthLimited: false,
      causalBreadthLimited: true,
      fanoutLimited: false,
    };
  }

  const signal: WorkspaceEventTriggerSignal = {
    kind: 'event',
    source: 'workspace',
    event_id: event.id,
    event_type: event.semanticType,
    delivery_id: `workspace-event:${event.id}`,
    occurred_at: event.occurredAt,
    root_event_ids: payload.rootEventIds,
    causal_behavior_ids: causalBehaviorIds,
    depth: payload.depth,
  };
  const { matches, fanoutLimited } =
    await findMatchingWorkspaceEventActivations(
      payload.organizationId,
      signal,
      event,
      db
    );
  const queued = [] as Array<{ runId: number; status: string }>;
  for (const match of matches) {
    const result = await createBehaviorEventRun({
      organizationId: match.organizationId,
      watcherId: match.behaviorId,
      agentId: match.agentId,
      trigger: match.trigger,
      signal,
      deviceWorkerId: match.deviceWorkerId,
      agentKind: match.agentKind,
    });
    if (result.disposition !== 'cooldown') queued.push(result);
  }
  await dispatchBehaviorRunsBestEffort(queued);
  return {
    matched: matches.length,
    queued: queued.length,
    depthLimited: false,
    causalBreadthLimited: false,
    fanoutLimited,
  };
}
