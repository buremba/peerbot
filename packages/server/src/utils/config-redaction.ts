/**
 * Redaction for config-change audit snapshots (`metadata.category='config'`
 * events). Mutation payloads can carry resolved secret material — platform
 * config arrives from `lobu apply` with `$VAR`/`secret()` refs already
 * resolved to plaintext — so every state snapshot is passed through here
 * before it is persisted into `events.payload_data`.
 *
 * Redacted values are replaced with REDACTED_SENTINEL (not dropped): the
 * future `lobu apply --from-revision` fold uses the sentinel to know which
 * paths the CLI must re-resolve from the local environment.
 */

export const REDACTED_SENTINEL = '__LOBU_REDACTED__';

/**
 * Key-name denylist applied on a deep walk of every snapshot. Matches the
 * whole key or a `_`-separated suffix, singular or plural, any case:
 * `token`, `apiKey`, `api_key`, `refresh_tokens`, `clientSecret`, ...
 */
const SECRET_KEY_RE =
  /(^|_)(token|secret|password|api_?key|credential|private_?key|refresh_?token|access_?token)s?$/i;

/** camelCase → snake_case so `apiKey`/`privateKey` hit the `_`-anchored regex. */
function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(normalizeKey(key));
}

function deepRedact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key) && v != null) {
        out[key] = REDACTED_SENTINEL;
      } else {
        out[key] = deepRedact(v);
      }
    }
    return out;
  }
  return value;
}

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

  const redacted = deepRedact(state) as Record<string, unknown>;

  if (kind === 'auth-profile' && redacted.credentials != null) {
    redacted.credentials = REDACTED_SENTINEL;
  }
  return redacted;
}
