import {
  decrypt,
  encrypt,
  isSecretKey,
  REDACTED_SENTINEL,
  redactUriCredentials,
} from '@lobu/core';
import { getDb } from '../db/client';
import logger from '../utils/logger';
import { isAdminOrOwnerRole } from './access-control';
import { AUDIT_SEMANTIC_TYPE } from './constants';

export const REQUEST_SNAPSHOT_TOOLS = new Set([
  'run_sdk',
  'query_sdk',
  'query_sql',
]);

export const KNOWN_SECRET_SHAPE_RE =
  /\b(?:sk[-_][a-z0-9_-]{8,}|xox[baprs]-[a-z0-9-]{8,}|gh[pousr]_[a-z0-9_]{12,}|AKIA[A-Z0-9]{16}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/gi;

const MAX_REQUEST_BYTES = 256 * 1024;

interface CapturedRequest {
  fields: {
    snapshot_status: 'complete' | 'too_large';
    snapshot_bytes?: number;
  };
  body?: string;
}

export type RequestSnapshotReadResult =
  | { status: 'ok'; request: unknown }
  | { status: 'too_large'; bytes: number }
  | { status: 'unavailable' }
  | { status: 'not_found' }
  | { status: 'forbidden' };

function redactString(value: string): string {
  return redactUriCredentials(value).replace(
    KNOWN_SECRET_SHAPE_RE,
    REDACTED_SENTINEL,
  );
}

function redactRequest(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return value;
  if (Array.isArray(value)) return value.map(redactRequest);
  if (typeof value !== 'object') return null;

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    redacted[key] = isSecretKey(key)
      ? REDACTED_SENTINEL
      : redactRequest(nested);
  }
  return redacted;
}

export function captureRequestSnapshot(params: {
  toolName: string;
  args: Record<string, unknown>;
}): CapturedRequest | null {
  if (!REQUEST_SNAPSHOT_TOOLS.has(params.toolName)) return null;

  try {
    const serialized = JSON.stringify(redactRequest(params.args));
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_REQUEST_BYTES) {
      return {
        fields: { snapshot_status: 'too_large', snapshot_bytes: bytes },
      };
    }

    return {
      fields: { snapshot_status: 'complete' },
      body: encrypt(serialized),
    };
  } catch (error) {
    logger.warn(
      { error, toolName: params.toolName },
      'Failed to capture tool request snapshot',
    );
    return null;
  }
}

export async function persistRequestSnapshot(params: {
  eventId: number;
  body: string;
}): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO tool_invocation_snapshots (event_id, body)
      VALUES (${params.eventId}, ${params.body})
      ON CONFLICT (event_id) DO NOTHING
    `;
  } catch (error) {
    logger.warn(
      { error, eventId: params.eventId },
      'Failed to persist tool request snapshot',
    );
  }
}

export async function readRequestSnapshotForCaller(params: {
  eventId: string;
  organizationId: string;
  userId: string | null;
  memberRole: string | null;
}): Promise<RequestSnapshotReadResult> {
  const sql = getDb();
  const rows = await sql<{
    created_by: string | null;
    payload_data: Record<string, unknown>;
    body: string | null;
  }>`
    SELECT e.created_by, e.payload_data, s.body
    FROM events e
    LEFT JOIN tool_invocation_snapshots s ON s.event_id = e.id
    WHERE e.id = ${params.eventId}
      AND e.organization_id = ${params.organizationId}
      AND e.semantic_type = ${AUDIT_SEMANTIC_TYPE}
      AND e.origin_type = 'tool_invocation'
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return { status: 'not_found' };

  const canRead =
    isAdminOrOwnerRole(params.memberRole) ||
    (params.memberRole != null &&
      params.userId != null &&
      row.created_by === params.userId);
  if (!canRead) return { status: 'forbidden' };

  const payload = row.payload_data;
  if (payload?.snapshot_status === 'too_large') {
    return {
      status: 'too_large',
      bytes:
        typeof payload.snapshot_bytes === 'number' ? payload.snapshot_bytes : 0,
    };
  }
  if (payload?.snapshot_status !== 'complete' || typeof row.body !== 'string') {
    return { status: 'unavailable' };
  }

  try {
    return { status: 'ok', request: JSON.parse(decrypt(row.body)) };
  } catch (error) {
    logger.warn(
      { error, eventId: params.eventId },
      'Failed to read tool request snapshot',
    );
    return { status: 'unavailable' };
  }
}
