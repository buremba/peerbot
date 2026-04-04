/**
 * InMemoryAgentStore — default AgentStore backed by in-memory Maps.
 *
 * Populated from files (dev mode) or via API (embedded mode).
 */

import type {
  AgentMetadata,
  AgentSettings,
  AgentStore,
  ChannelBinding,
  Grant,
  StoredConnection,
} from "@lobu/core";

export class InMemoryAgentStore implements AgentStore {
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

  // ── Agent Settings ──────────────────────────────────────────────────

  async getSettings(agentId: string): Promise<AgentSettings | null> {
    return this.settings.get(agentId) ?? null;
  }

  async saveSettings(agentId: string, settings: AgentSettings): Promise<void> {
    this.settings.set(agentId, { ...settings, updatedAt: Date.now() });
  }

  async updateSettings(
    agentId: string,
    updates: Partial<AgentSettings>
  ): Promise<void> {
    const existing = this.settings.get(agentId);
    this.settings.set(agentId, {
      ...(existing || {}),
      ...updates,
      updatedAt: Date.now(),
    } as AgentSettings);
  }

  async deleteSettings(agentId: string): Promise<void> {
    this.settings.delete(agentId);
  }

  async hasSettings(agentId: string): Promise<boolean> {
    return this.settings.has(agentId);
  }

  // ── Agent Metadata ────────────────────────────────────────────────

  async getMetadata(agentId: string): Promise<AgentMetadata | null> {
    return this.metadata.get(agentId) ?? null;
  }

  async saveMetadata(agentId: string, metadata: AgentMetadata): Promise<void> {
    this.metadata.set(agentId, metadata);
    if (metadata.parentConnectionId) {
      let set = this.sandboxes.get(metadata.parentConnectionId);
      if (!set) {
        set = new Set();
        this.sandboxes.set(metadata.parentConnectionId, set);
      }
      set.add(agentId);
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

  async deleteMetadata(agentId: string): Promise<void> {
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

  async hasAgent(agentId: string): Promise<boolean> {
    return this.metadata.has(agentId);
  }

  async listAgents(): Promise<AgentMetadata[]> {
    return Array.from(this.metadata.values());
  }

  async listSandboxes(connectionId: string): Promise<AgentMetadata[]> {
    const ids = this.sandboxes.get(connectionId);
    if (!ids) return [];
    const results: AgentMetadata[] = [];
    for (const id of ids) {
      const m = this.metadata.get(id);
      if (m) results.push(m);
    }
    return results;
  }

  // ── Connections ──────────────────────────────────────────────────

  async getConnection(connectionId: string): Promise<StoredConnection | null> {
    return this.connections.get(connectionId) ?? null;
  }

  async listConnections(filter?: {
    templateAgentId?: string;
    platform?: string;
  }): Promise<StoredConnection[]> {
    let ids: Iterable<string>;
    if (filter?.templateAgentId) {
      ids = this.connectionsByAgent.get(filter.templateAgentId) ?? [];
    } else {
      ids = this.connectionsAll;
    }

    let connections: StoredConnection[] = [];
    for (const id of ids) {
      const conn = this.connections.get(id);
      if (conn) connections.push(conn);
    }

    if (filter?.platform) {
      connections = connections.filter((c) => c.platform === filter.platform);
    }
    return connections;
  }

  async saveConnection(connection: StoredConnection): Promise<void> {
    this.connections.set(connection.id, connection);
    this.connectionsAll.add(connection.id);
    if (connection.templateAgentId) {
      let set = this.connectionsByAgent.get(connection.templateAgentId);
      if (!set) {
        set = new Set();
        this.connectionsByAgent.set(connection.templateAgentId, set);
      }
      set.add(connection.id);
    }
  }

  async updateConnection(
    connectionId: string,
    updates: Partial<StoredConnection>
  ): Promise<void> {
    const existing = this.connections.get(connectionId);
    if (!existing) return;
    await this.saveConnection({
      ...existing,
      ...updates,
      id: connectionId,
      updatedAt: Date.now(),
    });
  }

  async deleteConnection(connectionId: string): Promise<void> {
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

  // ── Grants ──────────────────────────────────────────────────────

  private grantKey(agentId: string, pattern: string): string {
    return `${agentId}:${pattern}`;
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

    // Domain wildcard: sub.example.com -> *.example.com
    if (!pattern.startsWith("/")) {
      const parts = pattern.split(".");
      if (parts.length > 2) {
        const wildcard = `*.${parts.slice(1).join(".")}`;
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
      grants.push({
        pattern: key.substring(prefix.length),
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
    return `${platform}:${userId}`;
  }

  async addUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    const key = this.userKey(platform, userId);
    let set = this.userAgents.get(key);
    if (!set) {
      set = new Set();
      this.userAgents.set(key, set);
    }
    set.add(agentId);
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
      ? `${platform}:${channelId}:${teamId}`
      : `${platform}:${channelId}`;
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
    let set = this.channelBindingIndex.get(binding.agentId);
    if (!set) {
      set = new Set();
      this.channelBindingIndex.set(binding.agentId, set);
    }
    set.add(key);
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
