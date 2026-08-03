import type { DbClient } from '../db/client';
import type { EventOutput } from '../types/watchers';
import { ToolUserError } from './errors';
import { insertEvent, type InsertedEvent } from './insert-event';
import { isUniqueViolation } from './pg-errors';
import { validateSaveContentSemanticType } from './event-kind-validation';

interface EventDraft {
  content: string;
  title?: string;
  metadata?: Record<string, unknown>;
  author?: string;
  source_url?: string;
  occurred_at?: string;
  parent_event_id?: number;
  payload_type?: 'text' | 'markdown';
  idempotency_key?: string;
}

export interface PersistBehaviorEventOutputParams {
  tx: DbClient;
  rows: unknown;
  outputName: string;
  output: EventOutput;
  watcherId: number;
  organizationId: string;
  windowId: number;
  runId: number | null;
  boundEntityIds: number[];
  validContentIds: Set<number>;
  occurredAt: string;
  createdBy?: string | null;
}

async function findByIdempotencyKey(
  tx: DbClient,
  organizationId: string,
  idempotencyKey: string
): Promise<InsertedEvent | null> {
  const rows = await tx<InsertedEvent>`
    SELECT id, entity_ids, origin_id, title, semantic_type, created_at,
           'unchanged'::text AS change
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata ? '_lobu_idempotency_key'
      AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Persist one declared event array atomically with its Canvas window. */
export async function persistBehaviorEventOutput(
  params: PersistBehaviorEventOutputParams
): Promise<InsertedEvent[]> {
  if (!Array.isArray(params.rows) || params.rows.length === 0) return [];
  const inserted: InsertedEvent[] = [];
  const producer = params.runId != null ? `run:${params.runId}` : `window:${params.windowId}`;

  for (let index = 0; index < params.rows.length; index++) {
    const draft = params.rows[index] as EventDraft;
    const metadata = { ...(draft.metadata ?? {}) };
    delete metadata._lobu_idempotency_key;

    const kindValidation = await validateSaveContentSemanticType(
      params.output.event,
      metadata,
      params.organizationId,
      params.boundEntityIds.length > 0 ? params.boundEntityIds : undefined
    );
    if (!kindValidation.valid) {
      throw new ToolUserError(
        `Invalid event in outputs.${params.outputName}[${index}]: ${kindValidation.errors.join('\n')}`,
        422
      );
    }

    let parentOriginId: string | null = null;
    let parentSourceUrl: string | null = null;
    if (draft.parent_event_id != null) {
      if (!params.validContentIds.has(draft.parent_event_id)) {
        throw new ToolUserError(
          `outputs.${params.outputName}[${index}].parent_event_id must reference content read by this Behavior window.`,
          422
        );
      }
      const parentRows = await params.tx<{ origin_id: string; source_url: string | null }>`
        SELECT origin_id, source_url
        FROM events
        WHERE id = ${draft.parent_event_id}
          AND organization_id = ${params.organizationId}
        LIMIT 1
      `;
      if (parentRows.length === 0 || !parentRows[0].origin_id) {
        throw new ToolUserError(
          `outputs.${params.outputName}[${index}].parent_event_id does not resolve to a source event.`,
          422
        );
      }
      parentOriginId = parentRows[0].origin_id;
      parentSourceUrl = parentRows[0].source_url;
    }

    const idempotencyKey = draft.idempotency_key
      ? `behavior:${params.watcherId}:output:${params.outputName}:key:${draft.idempotency_key}`
      : `behavior:${params.watcherId}:${producer}:output:${params.outputName}:item:${index}`;
    const prior = await findByIdempotencyKey(
      params.tx,
      params.organizationId,
      idempotencyKey
    );
    if (prior) {
      if (prior.semantic_type !== params.output.event) {
        throw new ToolUserError(
          `Behavior output idempotency key already belongs to '${prior.semantic_type}'.`,
          409
        );
      }
      inserted.push(prior);
      continue;
    }

    const eventMetadata = {
      ...metadata,
      _lobu_idempotency_key: idempotencyKey,
      behavior_id: params.watcherId,
      behavior_output: params.outputName,
      window_id: params.windowId,
    };
    try {
      inserted.push(
        await params.tx.savepoint((sp) =>
          insertEvent(
            {
              entityIds: params.boundEntityIds,
              organizationId: params.organizationId,
              originId: `behavior_${params.watcherId}_${params.outputName}_${producer.replace(':', '_')}_${index}`,
              title: draft.title ?? null,
              payloadType: draft.payload_type ?? 'text',
              content: draft.content,
              authorName: draft.author ?? null,
              sourceUrl: draft.source_url ?? parentSourceUrl,
              occurredAt: draft.occurred_at ?? params.occurredAt,
              semanticType: params.output.event,
              originType: params.output.event,
              metadata: eventMetadata,
              parentOriginId,
              runId: params.runId,
              createdBy: params.createdBy ?? null,
            },
            { sql: sp }
          )
        )
      );
    } catch (error) {
      if (!isUniqueViolation(error, 'idx_events_org_idempotency_key')) throw error;
      const winner = await findByIdempotencyKey(
        params.tx,
        params.organizationId,
        idempotencyKey
      );
      if (!winner) throw error;
      inserted.push(winner);
    }
  }

  return inserted;
}
