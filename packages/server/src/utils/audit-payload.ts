/**
 * Strip the encrypted snapshot body from a tool-invocation audit payload.
 *
 * Audit events are ordinary rows in `events`, so any generic content read can
 * surface one. The snapshot is a separate, access-controlled artifact (creator
 * or admin/owner, via `getToolInvocationSnapshotForCaller`) and must not ride
 * along on a listing: the ciphertext is up to ~2MB of noise, and
 * `snapshot_sha256` is a digest of the plaintext, which would let any member
 * confirm a guessed request/response by recomputing it.
 *
 * The summary fields (`snapshot_version`, `snapshot_status`, `snapshot_bytes`)
 * stay — they tell a reader a snapshot exists and whether it is retrievable.
 */

import { AUDIT_SEMANTIC_TYPE } from '../tools/constants';

const TOOL_INVOCATION_ORIGIN_TYPE = 'tool_invocation';

export function omitToolInvocationSnapshotBody<T>(
  semanticType: string | null | undefined,
  originType: string | null | undefined,
  payload: T
): T {
  if (
    semanticType !== AUDIT_SEMANTIC_TYPE ||
    originType !== TOOL_INVOCATION_ORIGIN_TYPE ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (
    !Object.hasOwn(record, 'snapshot_ciphertext') &&
    !Object.hasOwn(record, 'snapshot_sha256')
  ) {
    return payload;
  }
  const summary = { ...record };
  delete summary.snapshot_ciphertext;
  delete summary.snapshot_sha256;
  return summary as T;
}
