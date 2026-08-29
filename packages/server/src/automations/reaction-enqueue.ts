/**
 * Transactional handoff for the Automation reaction script.
 *
 * The reaction used to run INLINE, after `complete_window`'s transaction had
 * already committed the window, its output events, and the schedule cursor. A
 * process death in that gap lost the reaction permanently: the run was durably
 * `completed`, so no replay path would ever fire it again (`complete_window`
 * short-circuits on an already-completed run and returns `completed_now:false`).
 * Enqueueing the handoff INSIDE the same transaction moves it across the
 * existing durability boundary — the reaction row and the window commit or roll
 * back together, and a crash before the handler claims it leaves a `pending`
 * task the scheduler picks up.
 *
 * Kept dependency-light and separate from `./reaction-task` (the RUNTIME) for
 * the reason `workspace-event-enqueue.ts` documents: the queueing end of a seam
 * must not drag in the consuming end. `complete-window.ts` imports only this
 * module, so committing a handoff never pulls in the sandbox executor.
 *
 * Exactly one task per source run, without needing a durable claim: the enqueue
 * is gated on the run's `running|claimed -> completed` transition, which the
 * completion UPDATE allows only once. The idempotency key is belt-and-braces
 * for two completions racing inside their own transactions — note the
 * scheduler's partial unique index only covers in-flight statuses, so the key
 * alone would NOT stop a re-enqueue after the task finished.
 */

import type { DbClient } from '../db/client';
import { AUTOMATION_REACTION_TASK } from '../scheduled/task-definitions';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';

/**
 * Everything the handler needs to REHYDRATE the reaction context from durable
 * state. Deliberately not a serialized context bundle: the extracted data,
 * window bounds and entity links all live on the source run and the Automation,
 * so a bundle would be a second copy that can only go stale between commit and
 * execution.
 */
export interface AutomationReactionTaskPayload {
  organizationId: string;
  automationId: number;
  sourceRunId: number;
}

/** Stable per-source-run key. Exported so tests and the handler agree on it. */
export function automationReactionIdempotencyKey(sourceRunId: number): string {
  return `${AUTOMATION_REACTION_TASK}:${sourceRunId}`;
}

/**
 * Queue the reaction handoff on `tx`. Call INSIDE the window transaction, only
 * when the run actually transitioned to completed and the Automation has a
 * compiled reaction script.
 *
 * `maxAttempts` is 3 to preserve the inline loop's budget exactly — the
 * executor burns a 60s wall-clock timeout per attempt, and the handler still
 * classifies non-transient failures so those stop after one.
 */
export async function enqueueAutomationReaction(
  tx: DbClient,
  payload: AutomationReactionTaskPayload,
  compiledScript: string
): Promise<number> {
  const idempotencyKey = automationReactionIdempotencyKey(payload.sourceRunId);
  const taskRunIds = await enqueueTasksInTransaction(tx, [
    {
      name: AUTOMATION_REACTION_TASK,
      payload,
      opts: {
        idempotencyKey,
        maxAttempts: 3,
        organizationId: payload.organizationId,
        automationId: payload.automationId,
        parentRunId: payload.sourceRunId,
      },
    },
  ]);
  const taskRunId = taskRunIds.get(idempotencyKey);
  if (taskRunId === undefined) {
    throw new Error(
      `Failed to resolve queued reaction task for source run ${payload.sourceRunId}`
    );
  }
  // Keep #3205's three-field payload while preserving the old inline path's
  // completion-time script. The task row is committed by this same transaction,
  // so a later script edit or clear cannot change an already-queued effect.
  await tx`
    UPDATE public.runs
    SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${tx.json({
      reaction_script_compiled: compiledScript,
    })}::jsonb
    WHERE id = ${taskRunId}
      AND run_type = 'task'
      AND action_key = ${AUTOMATION_REACTION_TASK}
  `;
  return taskRunId;
}
