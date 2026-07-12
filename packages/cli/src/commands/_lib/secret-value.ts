/**
 * Secret-bearing flag values for imperative infra commands.
 *
 * Follows the same convention as `lobu apply` config (`secret()` / `$VAR`):
 * a value starting with `$` names an environment variable resolved at call
 * time. The reference must be single-quoted on the command line
 * (`--key '$MY_KEY'`) — unquoted, the shell expands it before the CLI runs
 * and the real secret lands in argv anyway.
 */

/**
 * A `$`-prefixed value is only echoed back in errors when what follows is a
 * plausible env-var NAME (an identifier). Anything else could be a pasted
 * secret that happens to start with `$` — never put it on stderr.
 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve a flag value that may be a `$VAR` environment reference. */
export function resolveSecretFlag(raw: string, flagName: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`${flagName} must not be empty.`);
  }
  if (!value.startsWith("$")) return value;
  const name = value.slice(1);
  if (!ENV_VAR_NAME.test(name)) {
    throw new Error(
      `${flagName} starts with "$" but is not a valid environment variable name (value not shown).`
    );
  }
  const resolved = process.env[name];
  if (!resolved?.trim()) {
    throw new Error(
      `${flagName} references $${name}, but that environment variable is not set.`
    );
  }
  return resolved.trim();
}

/**
 * Parse repeatable `key=value` flag entries into a record. Values follow the
 * `$VAR` convention above, so `--credential 'token=$VERCEL_TOKEN'` reads the
 * env var instead of putting the token on the command line. Errors reference
 * entries only by index, never by content — a mistakenly pasted secret must
 * not end up on stderr, and even the "key" part can be one (`sk-live-…=`).
 */
export function parseKeyValueEntries(
  entries: string[],
  flagName: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [index, entry] of entries.entries()) {
    const label = `${flagName} entry #${index + 1}`;
    const eq = entry.indexOf("=");
    const key = eq > 0 ? entry.slice(0, eq).trim() : "";
    if (!key) {
      throw new Error(`${label} must be key=value (value not shown).`);
    }
    out[key] = resolveSecretFlag(entry.slice(eq + 1), label);
  }
  return out;
}
