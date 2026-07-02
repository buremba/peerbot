/**
 * Durable approval gate for a watcher's proposed change to a HUMAN-OWNED entity
 * field. Mirrors the manage_agents builder gate: a watcher that wants to overwrite
 * a field a human owns does NOT write — it queues a pending `runs` row
 * (run_type='internal', action_key='entity_field_change') + an
 * `interaction_type='approval'` event, and notifies the org's humans (durable
 * notification, no SSE dependency — headless + multi-replica safe). On approve the
 * change is applied via `mergeEntityFields` (the field stays human-owned, now
 * carrying the approved value); on reject nothing changes.
 *
 * This leaf owns only the queue + apply (like manage_agents); the
 * claim/try-approve/try-reject orchestration lives in manage_operations next to
 * `supersedeActionEvent`.
 */
import { getDb } from '../../db/client';
import { mergeEntityFields, type FieldMergeResult } from '../../utils/entity-field-merge';
import { insertEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { buildEventPermalink } from '../../utils/url-builder';
import type { ToolContext } from '../registry';
import { getOrgUrlContext } from '../view-urls';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';

/** Synthetic runs.action_key tagging a watcher field-change held for approval. */
export const ENTITY_FIELD_CHANGE_ACTION_KEY = 'entity_field_change';

/** Proposed field changes held in runs.action_input for a field-change gate run. */
export interface EntityFieldChangeProposal {
  entity_id: number;
  /** field_path -> proposed value (what the watcher/agent wanted to write). */
  fields: Record<string, unknown>;
  /** field_path -> current human-owned value (for the diff card). */
  current?: Record<string, unknown>;
  watcher_id?: number | null;
  /** Who proposed the change — drives the card label/author. Defaults to 'watcher'. */
  attribution?: 'watcher' | 'agent';
  reason?: string | null;
}

/**
 * Queue a watcher field-change for approval. Returns the pending run/event ids.
 * Called post-commit from the watcher promotion path.
 */
export async function proposeEntityFieldChange(
  ctx: ToolContext,
  proposal: EntityFieldChangeProposal
): Promise<{ runId: number; eventId: number; approvalUrl?: string }> {
  const sql = getDb();

  // Idempotency: complete_window is replay-safe (retries + concurrent replicas),
  // so the same blocked field-change can be proposed more than once. Collapse to a
  // single pending approval — if an identical pending run already exists for this
  // org+entity+proposed-fields, reuse it instead of stacking duplicate cards.
  const existing = await sql<{ id: number; event_id: number | null }>`
    SELECT r.id,
           (SELECT e.id FROM events e
              WHERE e.run_id = r.id
                AND e.interaction_status = 'pending'
              ORDER BY e.id DESC LIMIT 1) AS event_id
    FROM runs r
    WHERE r.organization_id = ${ctx.organizationId}
      AND r.run_type = 'internal'
      AND r.action_key = ${ENTITY_FIELD_CHANGE_ACTION_KEY}
      AND r.approval_status = 'pending'
      AND r.status = 'pending'
      AND r.action_input->>'entity_id' = ${String(proposal.entity_id)}
      AND r.action_input->'fields' = ${sql.json(proposal.fields)}::jsonb
    ORDER BY r.id DESC
    LIMIT 1
  `;
  if (existing.length > 0) {
    const runId = Number(existing[0].id);
    const eventId = existing[0].event_id != null ? Number(existing[0].event_id) : 0;
    return { runId, eventId };
  }

  const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, action_key, action_input,
      created_by_user_id, approval_status, status, created_at
    ) VALUES (
      ${ctx.organizationId}, 'internal', ${ENTITY_FIELD_CHANGE_ACTION_KEY},
      ${sql.json(proposal as unknown as Record<string, unknown>)},
      null, 'pending', 'pending', current_timestamp
    )
    RETURNING id
  `;
  const runId = Number((inserted[0] as { id: unknown }).id);

  const fieldList = Object.keys(proposal.fields).join(', ');
  const attribution = proposal.attribution ?? 'watcher';
  const actorNoun = attribution === 'agent' ? 'An agent' : 'A watcher';
  const label = `${actorNoun} proposes changing ${fieldList}`;
  const event = await insertEvent({
    entityIds: [proposal.entity_id],
    organizationId: ctx.organizationId,
    originId: `run_${runId}_pending`,
    title: `${label} — pending approval`,
    content: proposal.reason ?? `${actorNoun} proposed updating ${fieldList} on this entity.`,
    semanticType: 'operation',
    runId,
    interactionType: 'approval',
    interactionStatus: 'pending',
    interactionInput: proposal as unknown as Record<string, unknown>,
    metadata: {
      tool: 'entity_field_change',
      action_key: ENTITY_FIELD_CHANGE_ACTION_KEY,
      entity_id: proposal.entity_id,
      fields: proposal.fields,
      current: proposal.current ?? null,
      watcher_id: proposal.watcher_id ?? null,
      attribution,
      reason: proposal.reason ?? null,
      status: 'pending_approval',
      run_id: runId,
    },
    authorName: attribution,
  });
  const eventId = Number(event.id);

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  const approvalUrl =
    ownerSlug && baseUrl ? buildEventPermalink(ownerSlug, eventId, baseUrl) : undefined;

  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: ENTITY_FIELD_CHANGE_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
  }).catch((error) =>
    logger.error(error, 'Failed to send entity_field_change approval notification')
  );

  return { runId, eventId, approvalUrl };
}

/**
 * Apply an approved field-change proposal. The approver endorsed the value, so it
 * is written AND marked human-owned (now carrying the approved value) via
 * mergeEntityFields(source='human').
 */
export async function applyEntityFieldChangeProposal(
  proposal: EntityFieldChangeProposal,
  approverUserId: string | null
): Promise<FieldMergeResult> {
  const sql = getDb();
  return await sql.begin(async (tx) =>
    mergeEntityFields({
      tx,
      entityId: proposal.entity_id,
      fields: proposal.fields,
      source: 'human',
      actorId: approverUserId,
      note: proposal.reason ?? null,
      // Don't overwrite a field the human re-edited after this proposal was queued.
      expectedCurrent: proposal.current ?? null,
    })
  );
}
