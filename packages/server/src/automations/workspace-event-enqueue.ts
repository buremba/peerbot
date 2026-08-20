/**
 * Subscription lookup and activation queueing for workspace events.
 *
 * Split out of `workspace-event.ts` — which owns the activation RUNTIME — so
 * the audit write path can queue an activation without importing it. That
 * runtime reaches `runs/queue-service`, which imports `utils/insert-event` for
 * `stableJson`, so a writer importing the runtime directly would close an
 * import cycle. Same reason `workspace-event-contract.ts` is kept
 * dependency-light: the queueing end of a seam must not drag in the consuming
 * end.
 */

import type { DbClient } from '../db/client';
import { getDb, pgTextArray } from '../db/client';
import { WORKSPACE_EVENT_ACTIVATION_TASK } from '../scheduled/task-definitions';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import type { WorkspaceEventActivationTaskPayload } from './workspace-event-contract';

/**
 * Which of `eventTypes` at least one active Automation subscribes to.
 *
 * Callers pass the single name a subscription would use for the event — the
 * stamped `<subject>.<op>` type for a platform audit row, the semantic type
 * otherwise. Passing the raw semantic type of an audit row matches nothing,
 * which is deliberate: every audit row shares `change`.
 */
export async function findSubscribedWorkspaceEventTypes(
  organizationId: string,
  eventTypes: readonly string[],
  db: DbClient = getDb()
): Promise<Set<string>> {
  const candidates = [...new Set(eventTypes)];
  if (candidates.length === 0) return new Set();
  const rows = await db<{ event_type: string }>`
    SELECT DISTINCT event_type.value AS event_type
    FROM automations w
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(w.triggers, '[]'::jsonb)
    ) AS trigger(value)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(trigger.value->'event_types') = 'array'
          THEN trigger.value->'event_types'
        ELSE '[]'::jsonb
      END
    ) AS event_type(value)
    WHERE w.organization_id = ${organizationId}
      AND w.status = 'active'
      AND w.current_version_id IS NOT NULL
      AND (w.agent_id IS NOT NULL OR w.device_worker_id IS NOT NULL)
      AND trigger.value->>'kind' = 'event'
      AND trigger.value->>'source' = 'workspace'
      AND event_type.value = ANY(${pgTextArray(candidates)}::text[])
  `;
  return new Set(rows.map((row) => String(row.event_type)));
}

export async function enqueueWorkspaceEventActivations(
  tx: DbClient,
  payloads: WorkspaceEventActivationTaskPayload[]
): Promise<void> {
  await enqueueTasksInTransaction(
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
