/**
 * Centralized event insertion.
 *
 * Every row in the `events` table should go through this module so we have
 * a single place for validation, defaults, and future hooks (e.g. embeddings).
 */

import { getDb } from '../db/client';
import logger from './logger';

// ============================================
// Types
// ============================================

interface InsertEventParams {
  entityIds: number[];
  organizationId: string;
  originId: string;

  title?: string | null;
  payloadType?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  content?: string | null;
  payloadData?: Record<string, unknown>;
  payloadTemplate?: Record<string, unknown> | null;
  attachments?: unknown[];
  authorName?: string | null;
  sourceUrl?: string | null;
  occurredAt?: Date | string | null;
  semanticType: string;
  originType?: string | null;
  metadata?: Record<string, unknown>;

  /** Connector-sourced fields */
  connectorKey?: string | null;
  connectionId?: number | null;
  feedKey?: string | null;
  feedId?: number | null;
  runId?: number | null;
  parentOriginId?: string | null;
  score?: number | null;
  embedding?: number[] | null;
  interactionType?: 'none' | 'approval';
  interactionStatus?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interactionInputSchema?: Record<string, unknown> | null;
  interactionInput?: Record<string, unknown> | null;
  interactionOutput?: Record<string, unknown> | null;
  interactionError?: string | null;
  supersedesEventId?: number | null;

  /** Audit */
  createdBy?: string | null;
  clientId?: string | null;
}

interface InsertedEvent {
  id: number;
  entity_ids: number[] | null;
  origin_id: string;
  title: string | null;
  semantic_type: string;
  created_at: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

function normalizedTimestamp(value?: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function findCurrentEventByOrigin(
  sql: ReturnType<typeof getDb>,
  params: InsertEventParams
): Promise<
  | {
      id: number;
      title: string | null;
      payload_text: string | null;
      payload_type: string;
      payload_data: Record<string, unknown>;
      payload_template: Record<string, unknown> | null;
      attachments: unknown[];
      author_name: string | null;
      source_url: string | null;
      occurred_at: string | null;
      semantic_type: string;
      origin_type: string | null;
      metadata: Record<string, unknown>;
      score: number | null;
      origin_parent_id: string | null;
      interaction_type: string;
      interaction_status: string | null;
      interaction_input_schema: Record<string, unknown> | null;
      interaction_input: Record<string, unknown> | null;
      interaction_output: Record<string, unknown> | null;
      interaction_error: string | null;
    }
  | undefined
> {
  if (!params.connectionId || !params.originId) return undefined;

  const rows = await sql`
    SELECT e.id, e.title, e.payload_text, e.payload_type, e.payload_data, e.payload_template,
           e.attachments, e.author_name, e.source_url, e.occurred_at, e.semantic_type, e.origin_type,
           e.metadata, e.score, e.origin_parent_id, e.interaction_type, e.interaction_status,
           e.interaction_input_schema, e.interaction_input, e.interaction_output, e.interaction_error
    FROM events e
    WHERE e.connection_id = ${params.connectionId}
      AND e.origin_id = ${params.originId}
      AND NOT EXISTS (
        SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id
      )
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1
  `;

  return rows[0] as any;
}

function isSemanticallyEqual(
  existing: NonNullable<Awaited<ReturnType<typeof findCurrentEventByOrigin>>>,
  params: InsertEventParams
): boolean {
  return (
    (existing.title ?? null) === (params.title ?? null) &&
    (existing.payload_text ?? null) === (params.content ?? null) &&
    existing.payload_type === (params.payloadType ?? 'text') &&
    stableJson(existing.payload_data ?? {}) === stableJson(params.payloadData ?? {}) &&
    stableJson(existing.payload_template ?? null) === stableJson(params.payloadTemplate ?? null) &&
    stableJson(existing.attachments ?? []) === stableJson(params.attachments ?? []) &&
    (existing.author_name ?? null) === (params.authorName ?? null) &&
    (existing.source_url ?? null) === (params.sourceUrl ?? null) &&
    normalizedTimestamp(existing.occurred_at ?? null) ===
      normalizedTimestamp(params.occurredAt ?? null) &&
    existing.semantic_type === params.semanticType &&
    (existing.origin_type ?? null) === (params.originType ?? null) &&
    stableJson(existing.metadata ?? {}) === stableJson(params.metadata ?? {}) &&
    Number(existing.score ?? 0) === Number(params.score ?? 0) &&
    (existing.origin_parent_id ?? null) === (params.parentOriginId ?? null) &&
    existing.interaction_type === (params.interactionType ?? 'none') &&
    (existing.interaction_status ?? null) === (params.interactionStatus ?? null) &&
    stableJson(existing.interaction_input_schema ?? null) ===
      stableJson(params.interactionInputSchema ?? null) &&
    stableJson(existing.interaction_input ?? null) ===
      stableJson(params.interactionInput ?? null) &&
    stableJson(existing.interaction_output ?? null) ===
      stableJson(params.interactionOutput ?? null) &&
    (existing.interaction_error ?? null) === (params.interactionError ?? null)
  );
}

async function upsertEmbedding(eventId: number, embedding?: number[] | null): Promise<void> {
  if (!embedding || embedding.length === 0) return;
  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;
  await sql`
    INSERT INTO event_embeddings (event_id, embedding)
    VALUES (${eventId}, ${vectorLiteral}::vector)
    ON CONFLICT (event_id) DO NOTHING
  `;
}

function isEventsClientIdForeignKeyViolation(error: unknown): boolean {
  const err = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (err?.code !== '23503') return false;
  return (
    err.constraint === 'events_client_id_fkey' ||
    err.constraint_name === 'events_client_id_fkey' ||
    (typeof err.message === 'string' && err.message.includes('events_client_id_fkey'))
  );
}

/**
 * Insert a single event into the events table.
 *
 * Returns the inserted row (id, entity_ids, title, semantic_type, created_at).
 * If `onConflictUpdate` is true, performs an upsert on (connection_id, origin_id).
 */
export async function insertEvent(
  params: InsertEventParams,
  options?: { onConflictUpdate?: boolean }
): Promise<InsertedEvent> {
  const sql = getDb();

  const entityIdsValue = params.entityIds.length > 0 ? `{${params.entityIds.join(',')}}` : null;
  let supersedesEventId = params.supersedesEventId ?? null;

  const requestedClientId = params.clientId ?? null;

  if (options?.onConflictUpdate) {
    const existing = await findCurrentEventByOrigin(sql, params);
    if (existing) {
      if (isSemanticallyEqual(existing, params)) {
        await upsertEmbedding(existing.id, params.embedding);
        const existingRows = await sql`
          SELECT id, entity_ids, origin_id, title, semantic_type, created_at
          FROM events
          WHERE id = ${existing.id}
          LIMIT 1
        `;
        return existingRows[0] as InsertedEvent;
      }
      supersedesEventId = existing.id;
    }
  }

  const insertWithClientId = (clientId: string | null) => sql`
    INSERT INTO events (
      entity_ids, organization_id, origin_id, title,
      payload_type, payload_text, payload_data, payload_template, attachments, metadata,
      score, author_name, source_url, occurred_at, origin_parent_id, origin_type,
      connector_key, connection_id, feed_key, feed_id, run_id,
      semantic_type, client_id, created_by,
      interaction_type, interaction_status, interaction_input_schema, interaction_input,
      interaction_output, interaction_error, supersedes_event_id
    ) VALUES (
      ${entityIdsValue}::bigint[],
      ${params.organizationId},
      ${params.originId},
      ${params.title ?? null},
      ${params.payloadType ?? 'text'},
      ${params.content ?? null},
      ${sql.json(params.payloadData ?? {})},
      ${params.payloadTemplate ? sql.json(params.payloadTemplate) : null},
      ${sql.json(params.attachments ?? [])},
      ${sql.json(params.metadata ?? {})},
      ${params.score ?? null},
      ${params.authorName ?? null},
      ${params.sourceUrl ?? null},
      ${params.occurredAt ?? null},
      ${params.parentOriginId ?? null},
      ${params.originType ?? null},
      ${params.connectorKey ?? null},
      ${params.connectionId ?? null},
      ${params.feedKey ?? null},
      ${params.feedId ?? null},
      ${params.runId ?? null},
      ${params.semanticType},
      ${clientId},
      ${params.createdBy ?? null},
      ${params.interactionType ?? 'none'},
      ${params.interactionStatus ?? null},
      ${params.interactionInputSchema ? sql.json(params.interactionInputSchema) : null},
      ${params.interactionInput ? sql.json(params.interactionInput) : null},
      ${params.interactionOutput ? sql.json(params.interactionOutput) : null},
      ${params.interactionError ?? null},
      ${supersedesEventId}
    )
    RETURNING id, entity_ids, origin_id, title, semantic_type, created_at
  `;

  let result: Awaited<ReturnType<typeof insertWithClientId>>;
  try {
    result = await insertWithClientId(requestedClientId);
  } catch (error) {
    if (!requestedClientId || !isEventsClientIdForeignKeyViolation(error)) {
      throw error;
    }
    logger.warn(
      { clientId: requestedClientId },
      '[insert-event] retrying insert with client_id NULL — referenced oauth_clients row no longer exists'
    );
    result = await insertWithClientId(null);
  }

  const inserted = result[0] as InsertedEvent;
  await upsertEmbedding(inserted.id, params.embedding);
  return inserted;
}

// ============================================
// Change Event (fire-and-forget audit trail)
// ============================================

interface ChangeEventParams {
  entityIds: number[];
  organizationId: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  createdBy?: string | null;
  clientId?: string | null;
}

/**
 * Record a change event for audit purposes.
 *
 * Fire-and-forget — never throws, logs on failure.
 * Used for entity updates, watcher archival, connection/feed deletion, etc.
 */
export function recordChangeEvent(params: ChangeEventParams): void {
  if (params.entityIds.length === 0) return;

  const externalId = `change_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  insertEvent({
    entityIds: params.entityIds,
    organizationId: params.organizationId,
    originId: externalId,
    title: params.title,
    content: params.content,
    semanticType: 'change',
    metadata: params.metadata,
    createdBy: params.createdBy ?? null,
    clientId: params.clientId ?? null,
  }).catch((err) => {
    logger.warn({ err, title: params.title }, 'Failed to record change event');
  });
}
