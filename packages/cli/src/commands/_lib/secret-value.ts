/**
 * Secret-bearing flag values for imperative infra commands.
 *
 * Follows the same convention as `lobu apply` config (`secret()` / `$VAR`):
 * a value starting with `$` names an environment variable resolved at call
 * time, so real secrets never land in shell history or process listings.
 */

/** Resolve a flag value that may be a `$VAR` environment reference. */
export function resolveSecretFlag(raw: string, flagName: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`${flagName} must not be empty.`);
  }
  if (!value.startsWith("$")) return value;
  const name = value.slice(1);
  if (!name) {
    throw new Error(`${flagName} is "$" with no variable name.`);
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
 * `$VAR` convention above, so `--credential token=$VERCEL_TOKEN` reads the
 * env var instead of putting the token on the command line.
 */
export function parseKeyValueEntries(
  entries: string[],
  flagName: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new Error(`${flagName} entries must be key=value, got "${entry}".`);
    }
    const key = entry.slice(0, eq).trim();
    const rawValue = entry.slice(eq + 1);
    if (!key) {
      throw new Error(`${flagName} entries must be key=value, got "${entry}".`);
    }
    out[key] = resolveSecretFlag(rawValue, `${flagName} ${key}`);
  }
  return out;
}
