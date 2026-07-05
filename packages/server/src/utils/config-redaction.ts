/**
 * Redaction for config-change audit snapshots (`metadata.category='config'`
 * events). Mutation payloads can carry resolved secret material — platform
 * config arrives from `lobu apply` with `$VAR`/`secret()` refs already
 * resolved to plaintext — so every state snapshot is passed through here
 * before it is persisted into `events.payload_data`.
 *
 * The denylist walk and sentinel live in @lobu/core (`secret-redaction`),
 * shared with the CLI's manifest hashing; this module adds the per-kind
 * rules that only the server needs.
 */

import { deepRedactSecrets, REDACTED_SENTINEL } from '@lobu/core';

export { REDACTED_SENTINEL };

/**
 * Resource kinds for config-change events. Mirrors the CLI apply DiffRow
 * `kind` union so per-kind counts and per-resource rows line up in the
 * deployments UI without a mapping table.
 */
export type ConfigResourceKind =
  | 'agent'
  | 'agent-settings'
  | 'platform'
  | 'entity-type'
  | 'relationship-type'
  | 'watcher'
  | 'connector-definition'
  | 'auth-profile'
  | 'connection'
  | 'feed'
  | 'inference-provider'
  | 'provider-key';

/**
 * Redact a post-change state snapshot before persisting it.
 *
 * On top of the deep-walk denylist, per-kind hard rules cover fields whose
 * secret-ness the key name can't reveal:
 *  - `auth-profile`: `credentials` replaced wholesale (connector-defined keys).
 *  - `platform` / `connection`: `config` deep-walked (denylist) — platform
 *    config values arrive as resolved plaintext from the CLI.
 *  - `inference-provider`: `apiKey`/`api_key` (already denylisted; kept
 *    explicit as a guarantee, not a heuristic).
 *  - `provider-key`: never snapshotted — state is forced to null.
 */
export function redactConfigState(
  kind: ConfigResourceKind,
  state: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (state === null) return null;
  if (kind === 'provider-key') return null;

  const redacted = deepRedactSecrets(state) as Record<string, unknown>;

  if (kind === 'auth-profile' && redacted.credentials != null) {
    redacted.credentials = REDACTED_SENTINEL;
  }
  return redacted;
}
