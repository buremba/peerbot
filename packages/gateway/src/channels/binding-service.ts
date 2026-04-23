import { BaseRedisStore, createLogger } from "@lobu/core";
import type Redis from "ioredis";

const logger = createLogger("channel-binding-service");

/**
 * Channel binding - links a platform channel to a specific agent
 */
interface ChannelBinding {
  platform: string; // Platform identifier
  channelId: string;
  agentId: string;
  teamId?: string; // Optional workspace/team ID for multi-tenant platforms
  configuredBy?: string; // userId of who configured this binding
  configuredAt?: number; // When the binding was configured
  wasAdmin?: boolean; // Whether the configurer was an admin at time of configuration
  createdAt: number;
}

/**
 * Service for managing channel-to-agent bindings
 *
 * Storage patterns:
 * - Forward lookup: channel_binding:{platform}:{channelId} → binding data
 * - Forward lookup (Slack): channel_binding:{platform}:{teamId}:{channelId} → binding data
 * - Reverse index: channel_binding_index:{agentId} → Set of binding keys
 */
export class ChannelBindingService extends BaseRedisStore<ChannelBinding> {
  private readonly INDEX_PREFIX = "channel_binding_index";

  constructor(redis: Redis) {
    super({
      redis,
      keyPrefix: "channel_binding",
      loggerName: "channel-binding-service",
    });
  }

  /**
   * Build the binding key for a channel
   * Includes teamId for multi-tenant platforms (e.g., Slack workspaces)
   */
  private buildBindingKey(
    platform: string,
    channelId: string,
    teamId?: string
  ): string {
    if (teamId) {
      return this.buildKey(platform, teamId, channelId);
    }
    return this.buildKey(platform, channelId);
  }

  /**
   * Build the index key for an agent's bindings
   */
  private buildIndexKey(agentId: string): string {
    return `${this.INDEX_PREFIX}:${agentId}`;
  }

  /**
   * Get binding for a channel
   * Returns null if channel is not bound to any agent
   */
  async getBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<ChannelBinding | null> {
    const key = this.buildBindingKey(platform, channelId, teamId);
    const binding = await this.get(key);
    if (binding) {
      logger.debug(
        `Found binding for ${platform}/${channelId}: ${binding.agentId}`
      );
    }
    return binding;
  }

  /**
   * Create a binding from a channel to an agent
   * If the channel was already bound, the old binding is removed
   */
  async createBinding(
    agentId: string,
    platform: string,
    channelId: string,
    teamId?: string,
    options?: { configuredBy?: string; wasAdmin?: boolean }
  ): Promise<void> {
    const key = this.buildBindingKey(platform, channelId, teamId);

    // Check if already bound to a different agent
    const existing = await this.get(key);
    if (existing && existing.agentId !== agentId) {
      // Remove from old agent's index
      const oldIndexKey = this.buildIndexKey(existing.agentId);
      await this.redis.srem(oldIndexKey, key);
      logger.info(
        `Removed binding from agent ${existing.agentId} for ${platform}/${channelId}`
      );
    }

    // Create the binding
    const binding: ChannelBinding = {
      platform,
      channelId,
      agentId,
      teamId,
      configuredBy: options?.configuredBy,
      configuredAt: Date.now(),
      wasAdmin: options?.wasAdmin,
      createdAt: Date.now(),
    };
    await this.set(key, binding);

    // Add to agent's index
    const indexKey = this.buildIndexKey(agentId);
    await this.redis.sadd(indexKey, key);

    logger.info(`Created binding: ${platform}/${channelId} → ${agentId}`);
  }

  /**
   * Delete a binding for a channel
   */
  async deleteBinding(
    agentId: string,
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<boolean> {
    const key = this.buildBindingKey(platform, channelId, teamId);
    const existing = await this.get(key);

    if (!existing) {
      logger.warn(`No binding found for ${platform}/${channelId}`);
      return false;
    }

    if (existing.agentId !== agentId) {
      logger.warn(
        `Binding for ${platform}/${channelId} belongs to ${existing.agentId}, not ${agentId}`
      );
      return false;
    }

    // Delete the binding
    await this.delete(key);

    // Remove from agent's index
    const indexKey = this.buildIndexKey(agentId);
    await this.redis.srem(indexKey, key);

    logger.info(`Deleted binding: ${platform}/${channelId} from ${agentId}`);
    return true;
  }

  /**
   * List all bindings for an agent
   */
  async listBindings(agentId: string): Promise<ChannelBinding[]> {
    const indexKey = this.buildIndexKey(agentId);
    const bindingKeys = await this.redis.smembers(indexKey);

    if (bindingKeys.length === 0) {
      return [];
    }

    const bindings: ChannelBinding[] = [];
    for (const key of bindingKeys) {
      const binding = await this.get(key);
      if (binding) {
        bindings.push(binding);
      } else {
        // Clean up stale index entry
        await this.redis.srem(indexKey, key);
      }
    }

    return bindings;
  }

  /**
   * Delete all bindings for an agent
   * Used when deleting an agent
   */
  async deleteAllBindings(agentId: string): Promise<number> {
    const bindings = await this.listBindings(agentId);

    for (const binding of bindings) {
      const key = this.buildBindingKey(
        binding.platform,
        binding.channelId,
        binding.teamId
      );
      await this.delete(key);
    }

    // Delete the index
    const indexKey = this.buildIndexKey(agentId);
    await this.redis.del(indexKey);

    logger.info(`Deleted ${bindings.length} bindings for agent ${agentId}`);
    return bindings.length;
  }
}
