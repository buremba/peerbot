import type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentMetadata,
  AgentSettings,
  ChannelBinding,
  Grant,
  StoredConnection,
} from "@lobu/core";
import type Redis from "ioredis";
import type { AgentMetadataStore } from "../auth/agent-metadata-store";
import type { AgentSettingsStore } from "../auth/settings";
import type { ChannelBindingService } from "../channels";
import type { GrantStore } from "../permissions/grant-store";
import type { UserAgentsStore } from "../auth/user-agents-store";

export class RedisAgentConfigStore implements AgentConfigStore {
  constructor(
    private readonly settingsStore: AgentSettingsStore,
    private readonly metadataStore: AgentMetadataStore
  ) {}

  async getSettings(agentId: string): Promise<AgentSettings | null> {
    return this.settingsStore.getSettings(agentId);
  }

  async saveSettings(agentId: string, settings: AgentSettings): Promise<void> {
    await this.settingsStore.saveSettings(agentId, settings);
  }

  async updateSettings(
    agentId: string,
    updates: Partial<AgentSettings>
  ): Promise<void> {
    await this.settingsStore.updateSettings(agentId, updates);
  }

  async deleteSettings(agentId: string): Promise<void> {
    await this.settingsStore.deleteSettings(agentId);
  }

  async hasSettings(agentId: string): Promise<boolean> {
    return this.settingsStore.hasSettings(agentId);
  }

  async getMetadata(agentId: string): Promise<AgentMetadata | null> {
    return this.metadataStore.getMetadata(agentId);
  }

  async saveMetadata(agentId: string, metadata: AgentMetadata): Promise<void> {
    await this.metadataStore.createAgent(
      agentId,
      metadata.name,
      metadata.owner.platform,
      metadata.owner.userId,
      {
        description: metadata.description,
        isWorkspaceAgent: metadata.isWorkspaceAgent,
        workspaceId: metadata.workspaceId,
        parentConnectionId: metadata.parentConnectionId,
      }
    );
    if (metadata.lastUsedAt !== undefined) {
      await this.metadataStore.updateMetadata(agentId, {
        lastUsedAt: metadata.lastUsedAt,
      });
    }
  }

  async updateMetadata(
    agentId: string,
    updates: Partial<AgentMetadata>
  ): Promise<void> {
    await this.metadataStore.updateMetadata(agentId, updates);
  }

  async deleteMetadata(agentId: string): Promise<void> {
    await this.metadataStore.deleteAgent(agentId);
  }

  async hasAgent(agentId: string): Promise<boolean> {
    return this.metadataStore.hasAgent(agentId);
  }

  async listAgents(): Promise<AgentMetadata[]> {
    return this.metadataStore.listAllAgents();
  }

  async listSandboxes(connectionId: string): Promise<AgentMetadata[]> {
    return this.metadataStore.listSandboxes(connectionId);
  }
}

export class RedisAgentConnectionStore implements AgentConnectionStore {
  constructor(
    private readonly redis: Redis,
    private readonly channelBindingService: ChannelBindingService
  ) {}

  async getConnection(connectionId: string): Promise<StoredConnection | null> {
    const raw = await this.redis.get(`connection:${connectionId}`);
    return raw ? (JSON.parse(raw) as StoredConnection) : null;
  }

  async listConnections(filter?: {
    templateAgentId?: string;
    platform?: string;
  }): Promise<StoredConnection[]> {
    const ids = filter?.templateAgentId
      ? await this.redis.smembers(`connections:agent:${filter.templateAgentId}`)
      : await this.redis.smembers("connections:all");

    const connections: StoredConnection[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`connection:${id}`);
      if (!raw) continue;
      const connection = JSON.parse(raw) as StoredConnection;
      if (filter?.platform && connection.platform !== filter.platform) {
        continue;
      }
      connections.push(connection);
    }
    return connections;
  }

  async saveConnection(connection: StoredConnection): Promise<void> {
    const existing = await this.getConnection(connection.id);
    await this.redis.set(
      `connection:${connection.id}`,
      JSON.stringify(connection)
    );
    await this.redis.sadd("connections:all", connection.id);

    const previousTemplate = existing?.templateAgentId;
    if (previousTemplate && previousTemplate !== connection.templateAgentId) {
      await this.redis.srem(
        `connections:agent:${previousTemplate}`,
        connection.id
      );
    }
    if (connection.templateAgentId) {
      await this.redis.sadd(
        `connections:agent:${connection.templateAgentId}`,
        connection.id
      );
    }
  }

  async updateConnection(
    connectionId: string,
    updates: Partial<StoredConnection>
  ): Promise<void> {
    const existing = await this.getConnection(connectionId);
    if (!existing) return;
    await this.saveConnection({
      ...existing,
      ...updates,
      id: connectionId,
      updatedAt: Date.now(),
    });
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const existing = await this.getConnection(connectionId);
    await this.redis.del(`connection:${connectionId}`);
    await this.redis.srem("connections:all", connectionId);
    if (existing?.templateAgentId) {
      await this.redis.srem(
        `connections:agent:${existing.templateAgentId}`,
        connectionId
      );
    }
  }

  async getChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<ChannelBinding | null> {
    return this.channelBindingService.getBinding(platform, channelId, teamId);
  }

  async createChannelBinding(binding: ChannelBinding): Promise<void> {
    await this.channelBindingService.createBinding(
      binding.agentId,
      binding.platform,
      binding.channelId,
      binding.teamId
    );
  }

  async deleteChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<void> {
    const existing = await this.channelBindingService.getBinding(
      platform,
      channelId,
      teamId
    );
    if (!existing) return;
    await this.channelBindingService.deleteBinding(
      existing.agentId,
      platform,
      channelId,
      teamId
    );
  }

  async listChannelBindings(agentId: string): Promise<ChannelBinding[]> {
    return this.channelBindingService.listBindings(agentId);
  }

  async deleteAllChannelBindings(agentId: string): Promise<number> {
    return this.channelBindingService.deleteAllBindings(agentId);
  }
}

export class RedisAgentAccessStore implements AgentAccessStore {
  constructor(
    private readonly grantStore: GrantStore,
    private readonly userAgentsStore: UserAgentsStore
  ) {}

  async grant(
    agentId: string,
    pattern: string,
    expiresAt: number | null,
    denied?: boolean
  ): Promise<void> {
    await this.grantStore.grant(agentId, pattern, expiresAt, denied);
  }

  async hasGrant(agentId: string, pattern: string): Promise<boolean> {
    return this.grantStore.hasGrant(agentId, pattern);
  }

  async isDenied(agentId: string, pattern: string): Promise<boolean> {
    return this.grantStore.isDenied(agentId, pattern);
  }

  async listGrants(agentId: string): Promise<Grant[]> {
    return this.grantStore.listGrants(agentId);
  }

  async revokeGrant(agentId: string, pattern: string): Promise<void> {
    await this.grantStore.revoke(agentId, pattern);
  }

  async addUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    await this.userAgentsStore.addAgent(platform, userId, agentId);
  }

  async removeUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    await this.userAgentsStore.removeAgent(platform, userId, agentId);
  }

  async listUserAgents(platform: string, userId: string): Promise<string[]> {
    return this.userAgentsStore.listAgents(platform, userId);
  }

  async ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean> {
    return this.userAgentsStore.ownsAgent(platform, userId, agentId);
  }
}
