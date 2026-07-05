/**
 * Shared secret redaction for config audit surfaces.
 *
 * One denylist, two consumers with one secret model between them:
 *  - the server redacts config-change audit snapshots before persisting them
 *    (`packages/server/src/utils/config-redaction.ts`), and
 *  - the CLI strips secret values out of the desired state before hashing it
 *    into a deployment's `manifest_hash` (`_lib/apply/deployment.ts`).
 *
 * Keeping both on this module means a key classified as secret is redacted
 * from stored snapshots AND excluded from the manifest hash in the same
 * release — they can't drift apart.
 */

/**
 * Placeholder written in place of a redacted value (never dropped): the
 * future `lobu apply --from-revision` fold uses it to know which paths the
 * CLI must re-resolve from the local environment.
 */
export const REDACTED_SENTINEL = "__LOBU_REDACTED__";

/**
 * Key-name denylist. Matches the whole key or a `_`-separated suffix,
 * singular or plural, any case: `token`, `apiKey`, `api_key`,
 * `refresh_tokens`, `clientSecret`, ...
 */
const SECRET_KEY_RE =
  /(^|_)(token|secret|password|api_?key|credential|private_?key|refresh_?token|access_?token)s?$/i;

/** camelCase → snake_case so `apiKey`/`privateKey` hit the `_`-anchored regex. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/**
 * Deep-walk a JSON-ish value, replacing every non-null value under a
 * denylisted key with REDACTED_SENTINEL. Arrays and nested objects are
 * walked; primitives pass through untouched.
 */
export function deepRedactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        isSecretKey(key) && v != null
          ? REDACTED_SENTINEL
          : deepRedactSecrets(v);
    }
    return out;
  }
  return value;
}
