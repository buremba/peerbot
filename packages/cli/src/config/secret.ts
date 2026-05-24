/**
 * A reference to a secret resolved at `lobu apply` time from the environment
 * (`.env` / `process.env`). The real value is never embedded in committed code;
 * `secret("GITHUB_TOKEN")` is the TypeScript spelling of TOML's `$GITHUB_TOKEN`.
 *
 * The apply loader resolves the reference to a `$NAME` placeholder, collects it
 * into the required-secrets set, and pushes the resolved value to the server.
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
