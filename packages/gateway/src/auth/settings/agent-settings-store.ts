import {
  BaseRedisStore,
  type GitConfig,
  type McpServerConfig,
  type NetworkConfig,
  type NixConfig,
  type PluginsConfig,
  type SkillsConfig,
  type ToolsConfig,
} from "@lobu/core";
import type Redis from "ioredis";

/**
 * Agent settings - configurable per agentId via web UI
 * Stored in Redis at agent:settings:{agentId}
 */
export interface AgentSettings {
  /** Claude model to use (e.g., claude-sonnet-4, claude-opus-4) */
  model?: string;
  /** Network access configuration */
  networkConfig?: NetworkConfig;
  /** Git repository configuration */
  gitConfig?: GitConfig;
  /** Nix environment configuration */
  nixConfig?: NixConfig;
  /** Additional MCP servers */
  mcpServers?: Record<string, McpServerConfig>;
  /** Internal marker: MCP IDs already acknowledged to the user in chat */
  mcpInstallNotified?: Record<string, number>;
  /** Environment variables passed to worker (KEY=VALUE pairs) */
  envVars?: Record<string, string>;
  /** Workspace identity/instruction files (markdown content) */
  soulMd?: string;
  /** Workspace user-specific context (markdown content) */
  userMd?: string;
  /** Workspace agent identity description (markdown content) */
  identityMd?: string;
  /** Skills configuration - enabled skills from skills.sh */
  skillsConfig?: SkillsConfig;
  /** Tool permission configuration - allowed/denied tools */
  toolsConfig?: ToolsConfig;
  /** OpenClaw plugin configuration */
  pluginsConfig?: PluginsConfig;
  /** Enable verbose logging (show tool calls, reasoning, etc.) */
  verboseLogging?: boolean;
  /** Connected GitHub user info */
  githubUser?: {
    login: string;
    id: number;
    avatarUrl: string;
    accessToken: string; // For user-scoped GitHub API calls
    connectedAt: number;
  };
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Store and retrieve agent settings from Redis
 * Pattern: agent:settings:{agentId}
 *
 * Settings are stored per agentId, which can be:
 * - Hash-based (from resolveSpace): e.g., "user-a1b2c3d4"
 * - Explicit (from channel binding): any custom agentId
 */
export class AgentSettingsStore extends BaseRedisStore<AgentSettings> {
  constructor(redis: Redis) {
    super({
      redis,
      keyPrefix: "agent:settings",
      loggerName: "agent-settings-store",
    });
  }

  /**
   * Get settings for an agent
   * Returns null if no settings configured
   */
  async getSettings(agentId: string): Promise<AgentSettings | null> {
    const key = this.buildKey(agentId);
    return this.get(key);
  }

  /**
   * Save settings for an agent
   * Overwrites existing settings
   */
  async saveSettings(
    agentId: string,
    settings: Omit<AgentSettings, "updatedAt">
  ): Promise<void> {
    const key = this.buildKey(agentId);
    const fullSettings: AgentSettings = {
      ...settings,
      updatedAt: Date.now(),
    };
    await this.set(key, fullSettings);
    this.logger.info(`Saved settings for agent ${agentId}`);
  }

  /**
   * Update specific settings fields (partial update)
   */
  async updateSettings(
    agentId: string,
    updates: Partial<Omit<AgentSettings, "updatedAt">>
  ): Promise<void> {
    const existing = await this.getSettings(agentId);
    const merged: AgentSettings = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };
    const key = this.buildKey(agentId);
    await this.set(key, merged);
    this.logger.info(`Updated settings for agent ${agentId}`);
  }

  /**
   * Delete settings for an agent
   */
  async deleteSettings(agentId: string): Promise<void> {
    const key = this.buildKey(agentId);
    await this.delete(key);
    this.logger.info(`Deleted settings for agent ${agentId}`);
  }

  /**
   * Check if agent has any settings configured
   */
  async hasSettings(agentId: string): Promise<boolean> {
    const key = this.buildKey(agentId);
    return this.exists(key);
  }
}
