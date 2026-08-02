/**
 * Tool-invocation snapshots: the exact redacted request/response of a call,
 * retained under encryption and served only to the caller or an admin/owner.
 *
 * Capture, encode, persist, authorize, decode. The audit ledger
 * (`tools/audit.ts`) records the SHAPE of every call and knows only that a
 * snapshot may exist; it never handles a body.
 *
 * SCOPE is the security boundary, not a size optimisation. The tools that
 * dominate audit volume (`manage_connections`, `manage_operations`) take raw
 * credentials as ARGUMENTS, and redacting those needs the connector's
 * schema-declared secret keys — `utils/connection-config-redaction.ts` calls
 * the keyname denylist a "backstop" precisely because it is not sufficient
 * alone. Rather than reimplement that layer here, those tools are out of
 * scope: {@link SNAPSHOT_TOOLS} only.
 *
 * STORAGE. Bodies live in `tool_invocation_snapshots`, never in
 * `events.payload_data` — rationale in that table's migration.
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

/**
 * Credential-SHAPED literals, matched on the value's own structure.
 *
 * `isSecretKey` only fires on a denylisted KEY, so a token pasted as a bare
 * literal inside a `script`/`sql` string would otherwise ride in verbatim.
 * Shape-matched, never word-adjacent — that distinction is why this is safe on
 * code where the reverted adjacency rule was not (see redactDeep). Shared with
 * the audit preview so the two redaction paths cannot drift.
 */
export const KNOWN_SECRET_SHAPE_RE =
  /\b(?:sk[-_][a-z0-9_-]{8,}|xox[baprs]-[a-z0-9-]{8,}|gh[pousr]_[a-z0-9_]{12,}|AKIA[A-Z0-9]{16}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/gi;

/** Plaintext ceiling. Past this the invocation is marked, never truncated —
 *  a half-recorded request is worse than an honest "too large". */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

interface ToolInvocationSnapshot {
  request: unknown;
  response: unknown;
}

/** What the audit row carries so a reader knows whether to offer the body. */
type SnapshotStatus = 'complete' | 'too_large' | 'error';

interface SnapshotCapture {
  /** Summary fields to merge into the audit event's payload_data. */
  fields: Record<string, unknown>;
  /** Encrypted body to persist once the event id is known; null when there is none. */
  body: string | null;
}

type SnapshotReadResult =
  | { status: 'ok'; snapshot: ToolInvocationSnapshot }
  | { status: 'too_large'; bytes: number }
  | { status: 'forbidden' | 'not_found' | 'unavailable' };

/** The single redaction applied to every string a snapshot keeps, wherever it
 *  sits in the tree — a leaf, or a field lifted off an `Error`. */
function redactString(value: string): string {
  return redactUriCredentials(value).replace(KNOWN_SECRET_SHAPE_RE, '[redacted]');
}

/**
 * Recursively rebuild `value` as JSON-safe data with secret-keyed leaves, URI
 * credentials, and credential-shaped literals removed.
 *
 * Note what this does NOT do: consume the token FOLLOWING a credential word.
 * An earlier revision did, and it corrupted the very artifact the snapshot
 * exists to preserve — `SELECT id, secret FROM t` came back as
 * `secret [redacted] t`, and `const token = await auth()` as
 * `token=[redacted] auth()`. For SQL and JavaScript, which is all this module
 * ever sees, those words are ordinary vocabulary. Key-scoped and shape-scoped
 * redaction are precise; word-adjacent redaction on code is not, and an
 * unreadable snapshot has no audit value at all.
 */
function redactDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
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
    // Every string here goes through the same redaction as any other leaf: a
    // thrown provider error routinely echoes the credential it was handed back
    // in its message (or its `code`), and this branch is the one path that
    // reaches a string without passing through the primitive case above.
    return {
      name: redactString(error.name),
      message: redactString(error.message),
      ...(typeof error.code === 'string' ? { code: redactString(error.code) } : {}),
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
  // Functions and symbols. `String(fn)` is its SOURCE, so this stringification
  // reaches a string like any leaf and gets the same redaction.
  return redactString(String(value));
}

/**
 * Build the snapshot for one invocation, or `null` when the tool is out of
 * scope. Never throws: a capture failure degrades to `snapshot_status: 'error'`
 * so the audit row still lands — otherwise one oversized `run_sdk` return would
 * silently erase the audit record of that call.
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
 * Persist a captured body against its now-known event id. Best effort: the
 * event is already durable, and the read path resolves the body from this table
 * rather than the event's status claim, so a failure here is an absence, never
 * a wrong answer.
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
 * Read one snapshot for a caller. Denials are distinct here (wrong org,
 * non-creator, absent body, stale key) and collapsed to one 404 by the route,
 * so the HTTP surface is not an existence oracle.
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
