import { readEnvironmentSecret } from "../../lobu/stores/provider-secrets.js";
import type {
  GatewayRuntimeProvider,
  ResolvedRuntimeCredentials,
} from "./types.js";

/**
 * Resolve a provider's credentials gateway-side, per field, with the same tier
 * order as model providers: org vault first (BYO), then deployment system env.
 * Keyed per-environment (`environment:<envId>:<field>`) when the token carries
 * an `environmentId`; otherwise system env only (self-host / org-default).
 *
 * Returns null when a `required` field can't be resolved — the route turns that
 * into a 424 so a misconfigured environment fails closed rather than running
 * unauthenticated. The plaintext never leaves the gateway.
 */
export async function resolveRuntimeCredentials(
  provider: GatewayRuntimeProvider,
  organizationId: string | undefined,
  environmentId: string | undefined
): Promise<ResolvedRuntimeCredentials | null> {
  const values: Record<string, string> = {};
  let source: "byo" | "system" = "system";

  for (const field of provider.credentialFields) {
    let value: string | null = null;
    if (organizationId && environmentId) {
      value = await readEnvironmentSecret(
        environmentId,
        field.key,
        organizationId
      );
      if (value) source = "byo";
    }
    if (!value) {
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
