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
  canvasRevisionId: number;
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

/**
 * The current head event for a keyed event output: the latest row of the
 * output's semantic type whose metadata carries the given key field values and
 * that nothing has superseded yet. `superseded_by IS NULL` identifies heads —
 * the insert-time dual-write stamps the replaced row's `superseded_by`, so a
 * key keeps exactly one current event while history stays append-only. The
 * match is scoped by (org, semantic type, key values) — deliberately NOT by
 * `behavior_id`, so a migrated/legacy event that predates the Behavior becomes
 * the supersede target of its first run rather than a duplicate.
 */
async function findCurrentHeadByKey(
  tx: DbClient,
  organizationId: string,
  semanticType: string,
  keyFields: readonly string[],
  metadata: Record<string, unknown>
): Promise<number | null> {
  const keyJson: Record<string, string> = {};
  for (const field of keyFields) {
    const value = metadata[field];
    const str =
      value === undefined || value === null ? null : String(value).trim();
    if (!str) return null;
    keyJson[field] = str;
  }
  const rows = await tx<{ id: number }>`
    SELECT id
    FROM events
    WHERE organization_id = ${organizationId}
      AND semantic_type = ${semanticType}
      AND superseded_by IS NULL
      AND metadata @> ${tx.json(keyJson)}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * `origin_id` for an event-output row whose draft carried an `idempotency_key`
 * — the source item's own stable id, so this names the row identically on every
 * run that rediscovers it.
 *
 * Exported because `events/backfill-behavior-output-origin-id.ts` re-stamps the
 * rows written before this derivation existed, and a backfill that reimplements
 * the encoding in SQL drifts from the writer the moment either changes.
 */
export function behaviorOutputOriginId(
  watcherId: number,
  outputName: string,
  idempotencyKey: string
): string {
  return `behavior_${watcherId}_${outputName}_key_${idempotencyKey}`;
}

/** Persist one declared event array atomically with its Canvas window. */
export async function persistBehaviorEventOutput(
  params: PersistBehaviorEventOutputParams
): Promise<InsertedEvent[]> {
  if (!Array.isArray(params.rows) || params.rows.length === 0) return [];
  const seenIdempotencyKeys = new Set<string>();
  const keyFields = params.output.key ?? null;
  const seenKeyValues = new Set<string>();
  for (let index = 0; index < params.rows.length; index++) {
    const draft = params.rows[index] as EventDraft;
    if (typeof draft?.idempotency_key !== 'string') continue;
    if (seenIdempotencyKeys.has(draft.idempotency_key)) {
      throw new ToolUserError(
        `outputs.${params.outputName} contains a duplicate idempotency_key at item ${index}.`,
        422
      );
    }
    seenIdempotencyKeys.add(draft.idempotency_key);
  }
  const inserted: InsertedEvent[] = [];
  const producer = `canvas:${params.canvasRevisionId}`;

  for (let index = 0; index < params.rows.length; index++) {
    const draft = params.rows[index] as EventDraft;
    const metadata = { ...(draft.metadata ?? {}) };
    delete metadata._lobu_idempotency_key;

    // Keyed event output: resolve the current head for this key and supersede
    // it, so the type keeps exactly one current event per key. A missing key
    // field is a malformed draft (the model must emit every declared key
    // field); a duplicate key within one array would otherwise double-supersede
    // the same head, so it is rejected up front.
    let supersedesEventId: number | null = null;
    if (keyFields) {
      const missing = keyFields.filter((f) => {
        const v = metadata[f];
        return v === undefined || v === null || String(v).trim() === '';
      });
      if (missing.length > 0) {
        throw new ToolUserError(
          `outputs.${params.outputName}[${index}] is missing required key field(s) in metadata: ${missing.join(', ')}.`,
          422
        );
      }
      const keyValue = keyFields.map((f) => `${f}=${String(metadata[f]).trim()}`).join('&');
      if (seenKeyValues.has(keyValue)) {
        throw new ToolUserError(
          `outputs.${params.outputName} contains a duplicate key (${keyFields.join(', ')}) at item ${index}.`,
          422
        );
      }
      seenKeyValues.add(keyValue);
      supersedesEventId = await findCurrentHeadByKey(
        params.tx,
        params.organizationId,
        params.output.event,
        keyFields,
        metadata
      );
    }

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

    // The row's identity, and the origin_id that must name it. A model-supplied
    // `idempotency_key` is the source item's own stable id, so it identifies the
    // row across runs; without one the row is only identifiable as its slot in
    // this Canvas revision. origin_id is DERIVED from the same identity rather
    // than stamped positionally: an hourly Behavior's runs all append to one
    // Canvas revision, so `..._${index}` named item N of every run the same
    // thing. Prod Behavior 71 put 8 unrelated posts under
    // `behavior_71_signals_canvas_4819569_4` — distinct rows, each correctly
    // deduped by its idempotency key, all sharing one origin_id. That breaks the
    // rule that origin_id is stable source identity: resolving one returned a
    // set of unrelated events.
    const idempotencyKey = draft.idempotency_key
      ? `behavior:${params.watcherId}:output:${params.outputName}:key:${draft.idempotency_key}`
      : `behavior:${params.watcherId}:${producer}:output:${params.outputName}:item:${index}`;
    const originId = draft.idempotency_key
      ? behaviorOutputOriginId(
          params.watcherId,
          params.outputName,
          draft.idempotency_key
        )
      : `behavior_${params.watcherId}_${params.outputName}_${producer.replace(':', '_')}_${index}`;
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
      window_revision_id: params.canvasRevisionId,
    };
    try {
      inserted.push(
        await params.tx.savepoint((sp) =>
          insertEvent(
            {
              entityIds: params.boundEntityIds,
              organizationId: params.organizationId,
              originId,
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
              supersedesEventId,
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
      if (winner.semantic_type !== params.output.event) {
        throw new ToolUserError(
          `Behavior output idempotency key already belongs to '${winner.semantic_type}'.`,
          409
        );
      }
      inserted.push(winner);
    }
  }

  return inserted;
}
