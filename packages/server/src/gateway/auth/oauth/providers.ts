/**
 * Subscription OAuth provider registry — loaded from config at boot.
 *
 * Source of truth: optional `oauth` blocks on entries in `config/providers.json`
 * (via {@link loadOAuthProvidersFromConfigs}). Runtime code never hard-codes
 * provider ids or endpoints; it only looks up rows here.
 */

import type {
	ProviderConfigEntry,
	ProviderOAuthConfig,
	ProviderOAuthGrantKind,
} from "@lobu/core";

export type OAuthGrantKind = ProviderOAuthGrantKind;

/** Runtime OAuth config: parent provider id/name + wire fields from JSON. */
export type OAuthProviderConfig = ProviderOAuthConfig & {
	id: string;
	name: string;
};

/** Mutable registry filled by {@link loadOAuthProvidersFromConfigs} at boot. */
let registry: Map<string, OAuthProviderConfig> = new Map();

/**
 * Replace the OAuth registry from provider-config entries that declare `oauth`.
 * Called once during gateway boot after `providers.json` is loaded.
 * Also used by tests to inject fixtures (pass a map or call with test configs).
 */
export function loadOAuthProvidersFromConfigs(
	configs: Record<string, ProviderConfigEntry>,
): OAuthProviderConfig[] {
	const next = new Map<string, OAuthProviderConfig>();
	for (const [id, entry] of Object.entries(configs)) {
		const oauth = entry.oauth;
		if (!oauth) continue;
		if (
			!oauth.clientId?.trim() ||
			!oauth.tokenUrl?.trim() ||
			!oauth.scope?.trim()
		) {
			throw new Error(
				`providers.json: provider "${id}" oauth block requires clientId, tokenUrl, and scope`,
			);
		}
		if (!oauth.grant) {
			throw new Error(
				`providers.json: provider "${id}" oauth block requires grant`,
			);
		}
		next.set(id, {
			...oauth,
			id,
			name: entry.displayName || id,
		});
	}
	registry = next;
	return listOAuthProviders();
}

/** Test / advanced: set the registry directly. */
export function setOAuthProviderRegistry(
	providers: readonly OAuthProviderConfig[],
): void {
	registry = new Map(providers.map((p) => [p.id, p]));
}

export function clearOAuthProviderRegistry(): void {
	registry = new Map();
}

export function listOAuthProviders(): OAuthProviderConfig[] {
	return [...registry.values()];
}

export function getOAuthProviderConfig(
	id: string,
): OAuthProviderConfig | undefined {
	return registry.get(id);
}

/** id → config snapshot for route allowlists. */
export function getOAuthProviderConfigs(): Readonly<
	Record<string, OAuthProviderConfig>
> {
	return Object.fromEntries(registry);
}

export function resolveOAuthScope(config: OAuthProviderConfig): string {
	if (config.scopeEnvVar) {
		const fromEnv = process.env[config.scopeEnvVar]?.trim();
		if (fromEnv) return fromEnv;
	}
	return config.scope;
}
