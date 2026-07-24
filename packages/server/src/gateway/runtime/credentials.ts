import { readSandboxSecret } from "../../lobu/stores/provider-secrets.js";
import type {
	GatewayRuntimeProvider,
	ResolvedRuntimeCredentials,
} from "./types.js";

/**
 * Resolve a provider's credentials gateway-side, per field. Two tiers, chosen by
 * whether the token carries a `sandboxId`:
 *
 *  - sandbox-bound (`sandboxId` present): read ONLY the per-sandbox vault key
 *    (`sandbox:<sandboxId>:<field>`). NO system-env fallback — a sandbox that
 *    names a specific realm must fail closed if its credential is gone (e.g. the
 *    sandbox was deleted, which purges its vault keys, and a conversation pinned
 *    to it later runs a turn). Falling back to system env here would silently run
 *    a pinned conversation under the host's ambient provider creds, violating the
 *    one-conversation-one-realm pin contract (and mirroring PR-0's kill of the
 *    sandbox-bound → system splice).
 *  - sandbox-less (no `sandboxId`, self-host / org-default): system env only.
 *
 * Returns null when a `required` field can't be resolved — the route turns that
 * into a 424 so a misconfigured/deleted sandbox fails closed rather than running
 * unauthenticated. The plaintext never leaves the gateway.
 */
export async function resolveRuntimeCredentials(
	provider: GatewayRuntimeProvider,
	organizationId: string | undefined,
	sandboxId: string | undefined,
): Promise<ResolvedRuntimeCredentials | null> {
	const values: Record<string, string> = {};
	// Sandbox-bound → BYO vault, no system splice; sandbox-less → system env.
	const sandboxBound = Boolean(organizationId && sandboxId);
	const source: "byo" | "system" = sandboxBound ? "byo" : "system";

	for (const field of provider.credentialFields) {
		let value: string | null = null;
		if (sandboxBound) {
			// organizationId + sandboxId are both set (sandboxBound); read the scoped
			// vault key only. A miss here fails closed below — no system fallback.
			value = await readSandboxSecret(
				sandboxId as string,
				field.key,
				organizationId as string,
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
