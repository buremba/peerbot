/**
 * Tool-invocation snapshots: the exact redacted request/response of a call,
 * retained under encryption and served only to the caller or an admin/owner.
 *
 * This module is the WHOLE feature — capture, encode, persist, authorize,
 * decode. The audit ledger (`tools/audit.ts`) records the SHAPE of every call
 * and knows only that a snapshot may exist; it never handles a body.
 *
 * Two design constraints shape everything here:
 *
 * SCOPE. Snapshots are limited to {@link SNAPSHOT_TOOLS} — the three tools
 * whose invocation history is itself the audit product (a script, a SQL
 * statement, and what they returned). This is not a size optimisation, it is
 * the security boundary. The generic audit branch deliberately persists NO
 * caller-controlled content, and the tools that dominate audit volume in prod
 * (`manage_connections`, `manage_operations` — 94% of rows) take raw
 * credentials as ARGUMENTS. Redacting those correctly needs the connector's
 * own schema-declared secret keys (see `utils/connection-config-redaction.ts`,
 * which calls the keyname denylist a "backstop" precisely because it is not
 * sufficient alone). Rather than reimplement that layer here, those tools are
 * simply out of scope.
 *
 * STORAGE. Bodies live in `tool_invocation_snapshots`, not in
 * `events.payload_data`. `events` is append-only and already ~12GB; a body
 * parked in it could never be aged out, and every generic content read would
 * need its own strip to avoid serving multi-megabyte ciphertext. A separate
 * relation makes both problems disappear: retention is an ordinary DELETE, and
 * no content path can surface a body because no content path joins this table.
 */

import { promisify } from 'node:util';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import {
  decryptBytes,
  encryptBytes,
  encryptionKeyFingerprint,
  isSecretKey,
  redactUriCredentials,
  REDACTED_SENTINEL,
} from '@lobu/core';
import { getDb } from '../db/client';
import logger from '../utils/logger';
import { isAdminOrOwnerRole } from './access-control';
import { AUDIT_SEMANTIC_TYPE } from './constants';

// zlib's async entry points run on libuv's threadpool. The sync ones block the
// event loop for the whole compress, which on a 2MiB body stalls every other
// request on the pod — and this runs inside the awaited tool-call path.
const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/**
 * Tools whose request/response is retained. See the SCOPE note above: this set
 * is the security boundary, not a tuning knob. Adding a tool here means
 * asserting that its arguments carry no credential the keyname denylist misses.
 */
export const SNAPSHOT_TOOLS: ReadonlySet<string> = new Set([
  'run_sdk',
  'query_sdk',
  'query_sql',
]);

/** Plaintext ceiling. Past this the invocation is marked, never truncated —
 *  a half-recorded request is worse than an honest "too large". */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface ToolInvocationSnapshot {
  request: unknown;
  response: unknown;
}

/** What the audit row carries so a reader knows whether to offer the body. */
export type SnapshotStatus = 'complete' | 'too_large' | 'error';

export interface SnapshotCapture {
  /** Summary fields to merge into the audit event's payload_data. */
  fields: Record<string, unknown>;
  /** Encrypted body to persist once the event id is known; null when there is none. */
  body: string | null;
}

export type SnapshotReadResult =
  | { status: 'ok'; snapshot: ToolInvocationSnapshot }
  | { status: 'too_large'; bytes: number }
  | { status: 'forbidden' | 'not_found' | 'unavailable' };

/**
 * Recursively rebuild `value` as JSON-safe data with secret-keyed leaves and
 * URI credentials removed.
 *
 * Note what this does NOT do: pattern-match free text for credential-shaped
 * substrings. An earlier revision did, and it corrupted the very artifact the
 * snapshot exists to preserve — `SELECT id, secret FROM t` came back as
 * `secret [redacted] t`, and `const token = await auth()` as
 * `token=[redacted] auth()`. For SQL and JavaScript, which is all this module
 * ever sees, those words are ordinary vocabulary. Key-scoped redaction is
 * precise; text-scoped redaction on code is not, and an unreadable snapshot
 * has no audit value at all.
 */
function redactDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactUriCredentials(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return { type: value.constructor.name, bytes: value.byteLength };
  }
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown };
    return {
      name: error.name,
      message: redactUriCredentials(error.message),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const mapped = value.map((item) => redactDeep(item, seen));
    seen.delete(value);
    return mapped;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] =
        isSecretKey(key) && nested != null
          ? REDACTED_SENTINEL
          : redactDeep(nested, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

/**
 * Build the snapshot for one invocation, or `null` when the tool is out of
 * scope. Never throws: a capture failure degrades to `snapshot_status: 'error'`
 * so the audit row itself still lands. (Coupling the cheap, near-guaranteed
 * ledger row to this expensive, failure-prone one would mean a single oversized
 * `run_sdk` return silently erases the audit record of that call.)
 */
export async function captureSnapshot(params: {
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: unknown;
}): Promise<SnapshotCapture | null> {
  if (!SNAPSHOT_TOOLS.has(params.toolName)) return null;
  try {
    const snapshot: ToolInvocationSnapshot = {
      request: redactDeep(params.args),
      response: redactDeep(params.error ?? params.result ?? null),
    };
    const serialized = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_SNAPSHOT_BYTES) {
      return { fields: snapshotFields('too_large', bytes), body: null };
    }
    const body = encryptBytes(await gzip(serialized));
    return { fields: snapshotFields('complete', bytes), body };
  } catch (error) {
    // Includes the RangeError JSON.stringify raises past the max string length,
    // which is exactly the unbounded-result case worth surviving.
    logger.warn(
      { err: error, toolName: params.toolName },
      'Failed to capture tool invocation snapshot; audit row kept without it'
    );
    return { fields: snapshotFields('error', null), body: null };
  }
}

function snapshotFields(
  status: SnapshotStatus,
  bytes: number | null
): Record<string, unknown> {
  return {
    snapshot_status: status,
    ...(bytes === null ? {} : { snapshot_bytes: bytes }),
  };
}

/**
 * Persist a captured body against its now-known event id. Best effort by
 * design: the audit event is already durable, and a missing row reads back as
 * `unavailable` — the read path never trusts the event's own status claim, so
 * a failure here cannot produce a lie, only an absence.
 */
export async function persistSnapshotBody(
  eventId: number,
  body: string
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO tool_invocation_snapshots (event_id, key_fingerprint, body)
      VALUES (${eventId}, ${encryptionKeyFingerprint()}, ${body})
      ON CONFLICT (event_id) DO NOTHING
    `;
  } catch (error) {
    logger.warn(
      { err: error, eventId },
      'Failed to persist tool invocation snapshot body'
    );
  }
}

/**
 * Read one snapshot for a caller.
 *
 * Every denial — wrong org, non-creator, absent body, stale key — is reported
 * distinctly here and collapsed to a single 404 by the route, so the HTTP
 * surface is not an existence oracle while the caller-side logs stay diagnostic.
 */
export async function readSnapshotForCaller(params: {
  eventId: string;
  organizationId: string;
  userId: string | null;
  memberRole: string | null;
}): Promise<SnapshotReadResult> {
  const sql = getDb();
  const rows = await sql<{
    created_by: string | null;
    payload_data: Record<string, unknown>;
    key_fingerprint: string | null;
    body: string | null;
  }>`
    SELECT e.created_by, e.payload_data, s.key_fingerprint, s.body
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

  if (row.payload_data?.snapshot_status === 'too_large') {
    const bytes = row.payload_data.snapshot_bytes;
    return { status: 'too_large', bytes: typeof bytes === 'number' ? bytes : 0 };
  }
  // Absent for: rows predating this feature, out-of-scope tools, a capture that
  // failed, and anything swept past the retention horizon. All the same answer.
  if (!row.body) return { status: 'unavailable' };
  // A rotated (or ephemeral) key cannot decrypt this body. That is an expected
  // end-of-life, not a fault — report it like any other absent body.
  if (row.key_fingerprint !== encryptionKeyFingerprint()) {
    return { status: 'unavailable' };
  }

  const serialized = (await gunzip(decryptBytes(row.body))).toString('utf8');
  return { status: 'ok', snapshot: JSON.parse(serialized) as ToolInvocationSnapshot };
}
