/**
 * A reference to a secret resolved at `lobu apply` time from the environment
 * (`.env` / `process.env`). The real value is never embedded in committed code.
 *
 * The apply loader collects each reference into the required-secrets set. For
 * provider `key` fields the resolved value is pushed to the server's secrets
 * store; for MCP and auth-profile credentials a `$NAME` placeholder is stored
 * and the real value is resolved at worker egress time, never uploaded.
 */
export interface SecretRef {
  readonly $secret: string;
}

/** Reference an environment-provided secret by name (resolved at apply time). */
export function secret(name: string): SecretRef {
  if (!name) {
    throw new Error("secret() requires a non-empty environment variable name");
  }
  return { $secret: name };
}

/** Narrow an unknown value to a {@link SecretRef}. */
export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SecretRef).$secret === "string"
  );
}
