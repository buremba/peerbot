/**
 * InMemoryAgentStore — default AgentStore backed by in-memory Maps.
 *
 * Populated from files (dev mode) or via API (embedded mode). Raw CRUD
 * primitives operate on Maps; the public AgentStore surface is inherited
 * from BaseAgentStore.
 */

import {
  inferGrantKind,
  normalizeDomainPattern,
  type AgentMetadata,
  type AgentSettings,
  type ChannelBinding,
  type Grant,
  type StoredConnection,
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
  private channelBindings = new Map<string, ChannelBinding>();
  private channelBindingIndex = new Map<string, Set<string>>();
  private grants = new Map<
    string,
    { expiresAt: number | null; grantedAt: number; denied?: boolean }
  >();
  private userAgents = new Map<string, Set<string>>();
  private sandboxes = new Map<string, Set<string>>();

  // ── Settings primitives ───────────────────────────────────────────

  protected async readSettings(agentId: string): Promise<AgentSettings | null> {
    return this.settings.get(agentId) ?? null;
  }

  protected async writeSettings(
    agentId: string,
    settings: AgentSettings
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
    if (metadata.parentConnectionId) {
      getOrCreateSet(this.sandboxes, metadata.parentConnectionId).add(agentId);
    }
  }

  async updateMetadata(
    agentId: string,
    updates: Partial<AgentMetadata>
  ): Promise<void> {
    const existing = this.metadata.get(agentId);
    if (!existing) return;
    await this.saveMetadata(agentId, { ...existing, ...updates });
  }

  protected async deleteMetadataRaw(agentId: string): Promise<void> {
    const existing = this.metadata.get(agentId);
    this.metadata.delete(agentId);
    if (existing?.parentConnectionId) {
      const set = this.sandboxes.get(existing.parentConnectionId);
      if (set) {
        set.delete(agentId);
        if (set.size === 0) this.sandboxes.delete(existing.parentConnectionId);
      }
    }
  }

  protected async hasMetadataRaw(agentId: string): Promise<boolean> {
    return this.metadata.has(agentId);
  }

  protected async listAllMetadata(): Promise<AgentMetadata[]> {
    return Array.from(this.metadata.values());
  }

  protected async listSandboxMetadata(
    connectionId: string
  ): Promise<AgentMetadata[]> {
    const ids = this.sandboxes.get(connectionId);
    if (!ids) return [];
    const results: AgentMetadata[] = [];
    for (const id of ids) {
      const m = this.metadata.get(id);
      if (m) results.push(m);
    }
    return results;
  }

  // ── Connection primitives ─────────────────────────────────────────

  protected async readConnection(
    connectionId: string
  ): Promise<StoredConnection | null> {
    return this.connections.get(connectionId) ?? null;
  }

  protected async writeConnection(connection: StoredConnection): Promise<void> {
    this.connections.set(connection.id, connection);
    this.connectionsAll.add(connection.id);
    if (connection.templateAgentId) {
      getOrCreateSet(this.connectionsByAgent, connection.templateAgentId).add(
        connection.id
      );
    }
  }

  protected async deleteConnectionRaw(connectionId: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    this.connections.delete(connectionId);
    this.connectionsAll.delete(connectionId);
    if (conn?.templateAgentId) {
      const set = this.connectionsByAgent.get(conn.templateAgentId);
      if (set) {
        set.delete(connectionId);
        if (set.size === 0)
          this.connectionsByAgent.delete(conn.templateAgentId);
      }
    }
  }

  protected async listConnectionsByTemplate(
    templateAgentId?: string
  ): Promise<StoredConnection[]> {
    const ids: Iterable<string> = templateAgentId
      ? (this.connectionsByAgent.get(templateAgentId) ?? [])
      : this.connectionsAll;

    const connections: StoredConnection[] = [];
    for (const id of ids) {
      const conn = this.connections.get(id);
      if (conn) connections.push(conn);
    }
    return connections;
  }

  // ── Grants ──────────────────────────────────────────────────────

  private grantKey(agentId: string, pattern: string): string {
    const normalizedPattern = pattern.startsWith("/")
      ? pattern
      : normalizeDomainPattern(pattern);

    return buildKey([agentId, normalizedPattern]);
  }

  private getValidGrant(
    agentId: string,
    pattern: string
  ): { expiresAt: number | null; grantedAt: number; denied?: boolean } | null {
    const key = this.grantKey(agentId, pattern);
    const entry = this.grants.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.grants.delete(key);
      return null;
    }
    return entry;
  }

  async grant(
    agentId: string,
    pattern: string,
    expiresAt: number | null,
    denied?: boolean
  ): Promise<void> {
    this.grants.set(this.grantKey(agentId, pattern), {
      expiresAt,
      grantedAt: Date.now(),
      ...(denied && { denied: true }),
    });
  }

  async hasGrant(agentId: string, pattern: string): Promise<boolean> {
    // Exact match
    const exact = this.getValidGrant(agentId, pattern);
    if (exact) return !exact.denied;

    // MCP wildcard: /mcp/gmail/tools/send_email -> /mcp/gmail/tools/*
    if (pattern.startsWith("/mcp/")) {
      const lastSlash = pattern.lastIndexOf("/");
      if (lastSlash > 0) {
        const wildcard = `${pattern.substring(0, lastSlash)}/*`;
        const entry = this.getValidGrant(agentId, wildcard);
        if (entry) return !entry.denied;
      }
    }

    // Domain wildcard: sub.example.com -> .example.com
    if (!pattern.startsWith("/")) {
      const parts = pattern.split(".");
      if (parts.length > 2) {
        const wildcard = `.${parts.slice(1).join(".")}`;
        const entry = this.getValidGrant(agentId, wildcard);
        if (entry) return !entry.denied;
      }
    }

    return false;
  }

  async isDenied(agentId: string, pattern: string): Promise<boolean> {
    const entry = this.getValidGrant(agentId, pattern);
    if (!entry) return false;
    return entry.denied === true;
  }

  async listGrants(agentId: string): Promise<Grant[]> {
    const prefix = `${agentId}:`;
    const grants: Grant[] = [];
    for (const [key, entry] of this.grants) {
      if (!key.startsWith(prefix)) continue;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        this.grants.delete(key);
        continue;
      }
      const pattern = key.substring(prefix.length);
      grants.push({
        pattern,
        kind: inferGrantKind(pattern),
        expiresAt: entry.expiresAt,
        grantedAt: entry.grantedAt,
        ...(entry.denied && { denied: true }),
      });
    }
    return grants;
  }

  async revokeGrant(agentId: string, pattern: string): Promise<void> {
    this.grants.delete(this.grantKey(agentId, pattern));
  }

  // ── User-Agent Associations ─────────────────────────────────────

  private userKey(platform: string, userId: string): string {
    return buildKey([platform, userId]);
  }

  async addUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    getOrCreateSet(this.userAgents, this.userKey(platform, userId)).add(
      agentId
    );
  }

  async removeUserAgent(
    platform: string,
    userId: string,
    agentId: string
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
    agentId: string
  ): Promise<boolean> {
    const set = this.userAgents.get(this.userKey(platform, userId));
    return set ? set.has(agentId) : false;
  }

  // ── Channel Bindings ────────────────────────────────────────────

  private channelBindingKey(
    platform: string,
    channelId: string,
    teamId?: string
  ): string {
    return teamId
      ? buildKey([platform, channelId, teamId])
      : buildKey([platform, channelId]);
  }

  async getChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<ChannelBinding | null> {
    return (
      this.channelBindings.get(
        this.channelBindingKey(platform, channelId, teamId)
      ) ?? null
    );
  }

  async createChannelBinding(binding: ChannelBinding): Promise<void> {
    const key = this.channelBindingKey(
      binding.platform,
      binding.channelId,
      binding.teamId
    );
    this.channelBindings.set(key, binding);
    getOrCreateSet(this.channelBindingIndex, binding.agentId).add(key);
  }

  async deleteChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<void> {
    const key = this.channelBindingKey(platform, channelId, teamId);
    const binding = this.channelBindings.get(key);
    if (binding) {
      const set = this.channelBindingIndex.get(binding.agentId);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.channelBindingIndex.delete(binding.agentId);
      }
    }
    this.channelBindings.delete(key);
  }

  async listChannelBindings(agentId: string): Promise<ChannelBinding[]> {
    const keys = this.channelBindingIndex.get(agentId);
    if (!keys) return [];
    const bindings: ChannelBinding[] = [];
    for (const key of keys) {
      const binding = this.channelBindings.get(key);
      if (binding) bindings.push(binding);
    }
    return bindings;
  }

  async deleteAllChannelBindings(agentId: string): Promise<number> {
    const keys = this.channelBindingIndex.get(agentId);
    if (!keys || keys.size === 0) return 0;
    const count = keys.size;
    for (const key of keys) {
      this.channelBindings.delete(key);
    }
    this.channelBindingIndex.delete(agentId);
    return count;
  }
}
