/**
 * InMemoryAgentStore — default AgentStore backed by in-memory Maps.
 *
 * Populated from files (dev mode) or via API (embedded mode). Raw CRUD
 * primitives operate on Maps; the public AgentStore surface is inherited
 * from BaseAgentStore.
 */

import type {
	AgentMetadata,
	AgentSettings,
	StoredConnection,
} from "@lobu/core";
import {
	BaseAgentStore,
	buildKey,
	getOrCreateSet,
} from "./base-agent-store.js";

export class InMemoryAgentStore extends BaseAgentStore {
	private settings = new Map<string, AgentSettings>();
	private metadata = new Map<string, AgentMetadata>();
	private connections = new Map<string, StoredConnection>();
	private connectionsAll = new Set<string>();
	private connectionsByAgent = new Map<string, Set<string>>();
	private userAgents = new Map<string, Set<string>>();

	// ── Settings primitives ───────────────────────────────────────────

	protected async readSettings(agentId: string): Promise<AgentSettings | null> {
		return this.settings.get(agentId) ?? null;
	}

	protected async writeSettings(
		agentId: string,
		settings: AgentSettings,
	): Promise<void> {
		this.settings.set(agentId, settings);
	}

	protected async deleteSettingsRaw(agentId: string): Promise<void> {
		this.settings.delete(agentId);
	}

	protected async hasSettingsRaw(agentId: string): Promise<boolean> {
		return this.settings.has(agentId);
	}

	// ── Metadata primitives ───────────────────────────────────────────

	protected async readMetadata(agentId: string): Promise<AgentMetadata | null> {
		return this.metadata.get(agentId) ?? null;
	}

	async saveMetadata(agentId: string, metadata: AgentMetadata): Promise<void> {
		this.metadata.set(agentId, metadata);
	}

	async updateMetadata(
		agentId: string,
		updates: Partial<AgentMetadata>,
	): Promise<void> {
		const existing = this.metadata.get(agentId);
		if (!existing) return;
		await this.saveMetadata(agentId, { ...existing, ...updates });
	}

	protected async deleteMetadataRaw(agentId: string): Promise<void> {
		this.metadata.delete(agentId);
	}

	protected async hasMetadataRaw(agentId: string): Promise<boolean> {
		return this.metadata.has(agentId);
	}

	protected async listAllMetadata(): Promise<AgentMetadata[]> {
		return Array.from(this.metadata.values());
	}

	// ── Connection primitives ─────────────────────────────────────────

	protected async readConnection(
		connectionId: string,
	): Promise<StoredConnection | null> {
		return this.connections.get(connectionId) ?? null;
	}

	protected async writeConnection(connection: StoredConnection): Promise<void> {
		this.connections.set(connection.id, connection);
		this.connectionsAll.add(connection.id);
		if (connection.agentId) {
			getOrCreateSet(this.connectionsByAgent, connection.agentId).add(
				connection.id,
			);
		}
	}

	protected async deleteConnectionRaw(connectionId: string): Promise<void> {
		const conn = this.connections.get(connectionId);
		this.connections.delete(connectionId);
		this.connectionsAll.delete(connectionId);
		if (conn?.agentId) {
			const set = this.connectionsByAgent.get(conn.agentId);
			if (set) {
				set.delete(connectionId);
				if (set.size === 0) this.connectionsByAgent.delete(conn.agentId);
			}
		}
	}

	protected async listConnectionsByAgent(
		agentId?: string,
	): Promise<StoredConnection[]> {
		const ids: Iterable<string> = agentId
			? (this.connectionsByAgent.get(agentId) ?? [])
			: this.connectionsAll;

		const connections: StoredConnection[] = [];
		for (const id of ids) {
			const conn = this.connections.get(id);
			if (conn) connections.push(conn);
		}
		return connections;
	}

	// ── User-Agent Associations ─────────────────────────────────────

	private userKey(platform: string, userId: string): string {
		return buildKey([platform, userId]);
	}

	async addUserAgent(
		platform: string,
		userId: string,
		agentId: string,
	): Promise<void> {
		getOrCreateSet(this.userAgents, this.userKey(platform, userId)).add(
			agentId,
		);
	}

	async removeUserAgent(
		platform: string,
		userId: string,
		agentId: string,
	): Promise<void> {
		const key = this.userKey(platform, userId);
		const set = this.userAgents.get(key);
		if (set) {
			set.delete(agentId);
			if (set.size === 0) this.userAgents.delete(key);
		}
	}

	async listUserAgents(platform: string, userId: string): Promise<string[]> {
		const set = this.userAgents.get(this.userKey(platform, userId));
		return set ? Array.from(set) : [];
	}

	async ownsAgent(
		platform: string,
		userId: string,
		agentId: string,
	): Promise<boolean> {
		const set = this.userAgents.get(this.userKey(platform, userId));
		return set ? set.has(agentId) : false;
	}
}
