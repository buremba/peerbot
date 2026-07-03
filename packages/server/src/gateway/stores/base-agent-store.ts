/**
 * BaseAgentStore — shared scaffolding for AgentStore implementations.
 *
 * Concrete stores (InMemoryAgentStore, host-provided Postgres stores) provide raw CRUD
 * primitives for each resource; the base class exposes the public AgentStore
 * interface on top of those primitives, centralizing the get→merge→save
 * update pattern and the listConnections platform filter.
 *
 * User-agent associations and channel bindings vary too much between the
 * in-memory (self-contained Maps) and the Postgres-backed paths (delegating
 * to UserAgentsStore / ChannelBindingService) to share concrete logic;
 * subclasses implement those groups directly. Grants use GrantStore.
 */

import type {
	AgentMetadata,
	AgentSettings,
	AgentStore,
	StoredConnection,
} from "@lobu/core";

/**
 * Join key parts with `:` — the canonical separator used by every
 * composite key in the gateway stores.
 */
export function buildKey(parts: string[]): string {
	return parts.join(":");
}

/**
 * Return the Set stored at `key`, creating (and inserting) an empty one if
 * it's missing. Saves the `if (!set) { set = new Set(); map.set(key, set); }`
 * dance at every call site.
 */
export function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	return set;
}

export abstract class BaseAgentStore implements AgentStore {
	// ── Settings primitives ────────────────────────────────────────────

	protected abstract readSettings(
		agentId: string,
	): Promise<AgentSettings | null>;
	protected abstract writeSettings(
		agentId: string,
		settings: AgentSettings,
	): Promise<void>;
	protected abstract deleteSettingsRaw(agentId: string): Promise<void>;
	protected abstract hasSettingsRaw(agentId: string): Promise<boolean>;

	// ── Metadata primitives ────────────────────────────────────────────
	//
	// `saveMetadata` / `updateMetadata` are abstract rather than expressed as
	// a shared read→merge→write pattern because the Postgres-backed path
	// delegates to `AgentMetadataStore.createAgent` for saves (which stamps a
	// fresh `createdAt`) and to `AgentMetadataStore.updateMetadata` for
	// updates (which preserves `createdAt` and accepts only a narrow subset
	// of fields). Routing updates through a shared `writeMetadata` primitive
	// would corrupt `createdAt` on every update call.

	protected abstract readMetadata(
		agentId: string,
	): Promise<AgentMetadata | null>;
	protected abstract deleteMetadataRaw(agentId: string): Promise<void>;
	protected abstract hasMetadataRaw(agentId: string): Promise<boolean>;
	protected abstract listAllMetadata(): Promise<AgentMetadata[]>;

	abstract saveMetadata(
		agentId: string,
		metadata: AgentMetadata,
	): Promise<void>;
	abstract updateMetadata(
		agentId: string,
		updates: Partial<AgentMetadata>,
	): Promise<void>;

	// ── Connection primitives ────────────────────────────────────────

	protected abstract readConnection(
		connectionId: string,
	): Promise<StoredConnection | null>;
	protected abstract writeConnection(
		connection: StoredConnection,
	): Promise<void>;
	protected abstract deleteConnectionRaw(connectionId: string): Promise<void>;
	protected abstract listConnectionsByAgent(
		agentId?: string,
	): Promise<StoredConnection[]>;

	// ── User-Agent Associations (implemented per-backend) ─────────────

	abstract addUserAgent(
		platform: string,
		userId: string,
		agentId: string,
	): Promise<void>;
	abstract removeUserAgent(
		platform: string,
		userId: string,
		agentId: string,
	): Promise<void>;
	abstract listUserAgents(platform: string, userId: string): Promise<string[]>;
	abstract ownsAgent(
		platform: string,
		userId: string,
		agentId: string,
	): Promise<boolean>;

	// ── Settings (AgentConfigStore) ────────────────────────────────────

	async getSettings(agentId: string): Promise<AgentSettings | null> {
		return this.readSettings(agentId);
	}

	async saveSettings(agentId: string, settings: AgentSettings): Promise<void> {
		await this.writeSettings(agentId, { ...settings, updatedAt: Date.now() });
	}

	async updateSettings(
		agentId: string,
		updates: Partial<AgentSettings>,
	): Promise<void> {
		const existing = await this.readSettings(agentId);
		await this.writeSettings(agentId, {
			...(existing || {}),
			...updates,
			updatedAt: Date.now(),
		} as AgentSettings);
	}

	async deleteSettings(agentId: string): Promise<void> {
		await this.deleteSettingsRaw(agentId);
	}

	async hasSettings(agentId: string): Promise<boolean> {
		return this.hasSettingsRaw(agentId);
	}

	// ── Metadata (AgentConfigStore) ────────────────────────────────────

	async getMetadata(agentId: string): Promise<AgentMetadata | null> {
		return this.readMetadata(agentId);
	}

	async deleteMetadata(agentId: string): Promise<void> {
		await this.deleteMetadataRaw(agentId);
	}

	async hasAgent(agentId: string): Promise<boolean> {
		return this.hasMetadataRaw(agentId);
	}

	async listAgents(): Promise<AgentMetadata[]> {
		return this.listAllMetadata();
	}

	// ── Connections (AgentConnectionStore) ────────────────────────────

	async getConnection(connectionId: string): Promise<StoredConnection | null> {
		return this.readConnection(connectionId);
	}

	async saveConnection(connection: StoredConnection): Promise<void> {
		await this.writeConnection(connection);
	}

	async updateConnection(
		connectionId: string,
		updates: Partial<StoredConnection>,
	): Promise<void> {
		const existing = await this.readConnection(connectionId);
		if (!existing) return;
		await this.saveConnection({
			...existing,
			...updates,
			id: connectionId,
			updatedAt: Date.now(),
		});
	}

	async deleteConnection(connectionId: string): Promise<void> {
		await this.deleteConnectionRaw(connectionId);
	}

	async listConnections(filter?: {
		agentId?: string;
		platform?: string;
	}): Promise<StoredConnection[]> {
		const connections = await this.listConnectionsByAgent(filter?.agentId);
		if (filter?.platform) {
			return connections.filter((c) => c.platform === filter.platform);
		}
		return connections;
	}
}
