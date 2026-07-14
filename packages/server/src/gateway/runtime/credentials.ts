import { readEnvironmentSecret } from "../../lobu/stores/provider-secrets.js";
import type {
  GatewayRuntimeProvider,
  ResolvedRuntimeCredentials,
} from "./types.js";

/**
 * Resolve a provider's credentials gateway-side, per field. Two tiers, chosen by
 * whether the token carries an `environmentId`:
 *
 *  - environment-bound (`environmentId` present): read ONLY the per-environment
 *    vault key (`environment:<envId>:<field>`). NO system-env fallback — an
 *    environment that names a specific realm must fail closed if its credential
 *    is gone (e.g. the environment was deleted, which purges its vault keys, and
 *    a conversation pinned to it later runs a turn). Falling back to system env
 *    here would silently run a pinned conversation under the host's ambient
 *    provider creds, violating the one-conversation-one-realm pin contract (and
 *    mirroring PR-0's kill of the env-bound → system splice).
 *  - env-less (no `environmentId`, self-host / org-default): system env only.
 *
 * Returns null when a `required` field can't be resolved — the route turns that
 * into a 424 so a misconfigured/deleted environment fails closed rather than
 * running unauthenticated. The plaintext never leaves the gateway.
 */
export async function resolveRuntimeCredentials(
  provider: GatewayRuntimeProvider,
  organizationId: string | undefined,
  environmentId: string | undefined
): Promise<ResolvedRuntimeCredentials | null> {
  const values: Record<string, string> = {};
  // Environment-bound → BYO vault, no system splice; env-less → system env.
  const envBound = Boolean(organizationId && environmentId);
  const source: "byo" | "system" = envBound ? "byo" : "system";

  for (const field of provider.credentialFields) {
    let value: string | null = null;
    if (envBound) {
      // organizationId + environmentId are both set (envBound); read the scoped
      // vault key only. A miss here fails closed below — no system fallback.
      value = await readEnvironmentSecret(
        environmentId as string,
        field.key,
        organizationId as string
      );
    } else {
      const envValue = process.env[field.systemEnvVar];
      value = envValue && envValue.trim() ? envValue : null;
    }
    if (value) {
      values[field.key] = value;
    } else if (field.required) {
      return null;
    }
  }

  return { values, source };
}
