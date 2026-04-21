/**
 * RedisAgentStore — Redis-backed AgentStore that extends BaseAgentStore.
 *
 * Primitives delegate to the purpose-built Redis services
 * (AgentSettingsStore, AgentMetadataStore, GrantStore, UserAgentsStore,
 * ChannelBindingService). Connections are stored directly against Redis
 * because they have no standalone service.
 */

import type {
  AgentMetadata,
  AgentSettings,
  ChannelBinding,
  Grant,
  StoredConnection,
} from "@lobu/core";
import type Redis from "ioredis";
import type { AgentMetadataStore } from "../auth/agent-metadata-store";
import type { AgentSettingsStore } from "../auth/settings";
import type { UserAgentsStore } from "../auth/user-agents-store";
import type { ChannelBindingService } from "../channels";
import type { GrantStore } from "../permissions/grant-store";
import { BaseAgentStore } from "./base-agent-store";

export class RedisAgentStore extends BaseAgentStore {
  constructor(
    private readonly redis: Redis,
    private readonly settingsStore: AgentSettingsStore,
    private readonly metadataStore: AgentMetadataStore,
    private readonly grantStore: GrantStore,
    private readonly userAgentsStore: UserAgentsStore,
    private readonly channelBindingService: ChannelBindingService
  ) {
    super();
  }

  // ── Settings primitives ───────────────────────────────────────────

  protected async readSettings(agentId: string): Promise<AgentSettings | null> {
    return this.settingsStore.getSettings(agentId);
  }

  protected async writeSettings(
    agentId: string,
    settings: AgentSettings
  ): Promise<void> {
    // `AgentSettingsStore.saveSettings` re-stamps `updatedAt`; the base class
    // already stamped it, so this is effectively a no-op overwrite.
    await this.settingsStore.saveSettings(agentId, settings);
  }

  protected async deleteSettingsRaw(agentId: string): Promise<void> {
    await this.settingsStore.deleteSettings(agentId);
  }

  protected async hasSettingsRaw(agentId: string): Promise<boolean> {
    return this.settingsStore.hasSettings(agentId);
  }

  // ── Metadata primitives ───────────────────────────────────────────

  protected async readMetadata(agentId: string): Promise<AgentMetadata | null> {
    return this.metadataStore.getMetadata(agentId);
  }

  protected async deleteMetadataRaw(agentId: string): Promise<void> {
    await this.metadataStore.deleteAgent(agentId);
  }

  protected async hasMetadataRaw(agentId: string): Promise<boolean> {
    return this.metadataStore.hasAgent(agentId);
  }

  protected async listAllMetadata(): Promise<AgentMetadata[]> {
    return this.metadataStore.listAllAgents();
  }

  protected async listSandboxMetadata(
    connectionId: string
  ): Promise<AgentMetadata[]> {
    return this.metadataStore.listSandboxes(connectionId);
  }

  async saveMetadata(agentId: string, metadata: AgentMetadata): Promise<void> {
    // `createAgent` overwrites unconditionally and stamps `createdAt` with
    // Date.now(); it accepts no `lastUsedAt` param, so we patch that in after.
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
    // AgentMetadataStore.updateMetadata only supports a narrow subset of
    // fields (name/description/lastUsedAt). Other fields are silently
    // dropped — same behavior as before the refactor.
    await this.metadataStore.updateMetadata(agentId, updates);
  }

  // ── Connection primitives ─────────────────────────────────────────

  protected async readConnection(
    connectionId: string
  ): Promise<StoredConnection | null> {
    const raw = await this.redis.get(`connection:${connectionId}`);
    return raw ? (JSON.parse(raw) as StoredConnection) : null;
  }

  protected async writeConnection(connection: StoredConnection): Promise<void> {
    const existing = await this.readConnection(connection.id);
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

  protected async deleteConnectionRaw(connectionId: string): Promise<void> {
    const existing = await this.readConnection(connectionId);
    await this.redis.del(`connection:${connectionId}`);
    await this.redis.srem("connections:all", connectionId);
    if (existing?.templateAgentId) {
      await this.redis.srem(
        `connections:agent:${existing.templateAgentId}`,
        connectionId
      );
    }
  }

  protected async listConnectionsByTemplate(
    templateAgentId?: string
  ): Promise<StoredConnection[]> {
    const ids = templateAgentId
      ? await this.redis.smembers(`connections:agent:${templateAgentId}`)
      : await this.redis.smembers("connections:all");

    const connections: StoredConnection[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`connection:${id}`);
      if (!raw) continue;
      connections.push(JSON.parse(raw) as StoredConnection);
    }
    return connections;
  }

  // ── Grants ──────────────────────────────────────────────────────

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

  // ── User-Agent Associations ─────────────────────────────────────

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

  // ── Channel Bindings ────────────────────────────────────────────

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
