/**
 * Server-side connector capability + emitter registry.
 *
 * The engine accepts arbitrary `(namespace, assurance,
 * providerStableId)` tuples from each connector. Without a server-side
 * registry, a buggy or malicious connector could emit
 * `oauth_verified_admin_role` or a namespace it has no business producing
 * and trigger privileged rules. This registry caps each connector's
 * authority at its declared capability.
 *
 * The registry is the SINGLE place core code learns about connectors.
 * Engine, auth-hook, and admin tooling consult the registry; nothing in
 * core code names a specific connector. New connectors are added by
 * dropping a file in `connectors/` and registering at the bottom of that
 * file via `registerConnector(...)` — `connectors/index.ts` imports each
 * file for the side effect.
 */

import {
	assuranceMeets,
	type AssuranceLevel,
	type ConnectorFact,
	type ConnectorIdentityCapability,
} from "@lobu/connector-sdk";

/**
 * Successful emit result. `facts` may be empty when the user's account is
 * legitimately producing no relevant attributes. The engine treats an
 * empty result authoritatively: prior facts get tombstoned.
 */
export interface ConnectorEmitResult {
	providerStableId: string;
	facts: ConnectorFact[];
}

export interface ConnectorEmitParams {
	accessToken: string;
	sourceAccountId: string;
}

/**
 * Connector emitter — fetches the provider's verified attributes for a
 * given access token and translates into ConnectorFacts. Returns `null`
 * On fetch failure (the caller MUST NOT call `ingestFacts` with a null
 * result, since that would tombstone everything on a transient outage).
 */
export type ConnectorEmitter = (
	params: ConnectorEmitParams,
) => Promise<ConnectorEmitResult | null>;

export interface ConnectorRegistration {
	capability: ConnectorIdentityCapability;
	emit: ConnectorEmitter;
}

interface RegistryEntry {
	registration: ConnectorRegistration;
	byNamespace: Map<string, AssuranceLevel>;
}

class ConnectorCapabilityRegistry {
	private readonly entries = new Map<string, RegistryEntry>();

	/**
	 * Register a connector. Throws on duplicate `connectorKey` to surface stray
	 * imports / mis-wired test bootstraps; tests that legitimately need to swap
	 * a registration use `replace: true`.
	 */
	register(
		registration: ConnectorRegistration,
		options?: { replace?: boolean },
	): void {
		const key = registration.capability.connectorKey;
		if (this.entries.has(key) && !options?.replace) {
			throw new Error(
				`connector capability already registered for "${key}"; pass { replace: true } to override`,
			);
		}
		const byNamespace = new Map<string, AssuranceLevel>();
		for (const produces of registration.capability.produces) {
			const prior = byNamespace.get(produces.namespace);
			if (!prior || assuranceMeets(produces.assurance, prior)) {
				byNamespace.set(produces.namespace, produces.assurance);
			}
		}
		this.entries.set(key, { registration, byNamespace });
	}

	/** Number of registered connectors — used by startup assertions. */
	size(): number {
		return this.entries.size;
	}

	get(connectorKey: string): RegistryEntry | undefined {
		return this.entries.get(connectorKey);
	}

	emitter(connectorKey: string): ConnectorEmitter | undefined {
		return this.entries.get(connectorKey)?.registration.emit;
	}

	/**
	 * Return the registered max-assurance for `(connectorKey, namespace)`,
	 * or `null` when the connector is not registered or doesn't declare the
	 * namespace at all. Engine rejects facts in either case — silence is not
	 * trust.
	 */
	maxAssurance(connectorKey: string, namespace: string): AssuranceLevel | null {
		const entry = this.entries.get(connectorKey);
		if (!entry) return null;
		return entry.byNamespace.get(namespace) ?? null;
	}

	/** Snapshot of every registered connector. */
	list(): ConnectorIdentityCapability[] {
		return Array.from(this.entries.values()).map(
			(entry) => entry.registration.capability,
		);
	}
}

export const connectorCapabilityRegistry = new ConnectorCapabilityRegistry();

/** Convenience for connector modules: `registerConnector({ capability, emit })`. */
export function registerConnector(registration: ConnectorRegistration): void {
	connectorCapabilityRegistry.register(registration);
}
