import {
  type AuthProfile,
  BaseRedisStore,
  decrypt,
  encrypt,
  type InstalledProvider,
  type McpServerConfig,
  type NetworkConfig,
  type NixConfig,
  type PluginsConfig,
  type SkillsConfig,
  safeJsonParse,
  safeJsonStringify,
  type ToolsConfig,
} from "@lobu/core";
import type Redis from "ioredis";
import type {
  ModelSelectionState,
  ProviderModelPreferences,
} from "./model-selection";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";

interface SensitiveValueDecodeResult {
  value: string;
  needsMigration: boolean;
}

/**
 * Agent settings - configurable per agentId via web UI
 * Stored in Redis at agent:settings:{agentId}
 */
export interface AgentSettings {
  /** Claude model to use (e.g., claude-sonnet-4, claude-opus-4) */
  model?: string;
  /** Model selection mode (auto provider/default model vs pinned provider/model). */
  modelSelection?: ModelSelectionState;
  /** Per-provider preferred model for auto mode. */
  providerModelPreferences?: ProviderModelPreferences;
  /** Network access configuration */
  networkConfig?: NetworkConfig;
  /** Nix environment configuration */
  nixConfig?: NixConfig;
  /** Additional MCP servers */
  mcpServers?: Record<string, McpServerConfig>;
  /** Internal marker: MCP IDs already acknowledged to the user in chat */
  mcpInstallNotified?: Record<string, number>;
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
  /** Ordered auth profiles (index 0 = primary). Used for multi-provider credential management. */
  authProfiles?: AuthProfile[];
  /** Installed providers for this agent (index 0 = primary). */
  installedProviders?: InstalledProvider[];
  /** Enable verbose logging (show tool calls, reasoning, etc.) */
  verboseLogging?: boolean;
  /** Template agent this sandbox was cloned from (for credential fallback) */
  templateAgentId?: string;
  /** Last updated timestamp */
  updatedAt: number;
}

export interface AgentSettingsContext {
  localSettings: AgentSettings | null;
  effectiveSettings: AgentSettings | null;
  templateAgentId?: string;
}

/**
 * Store and retrieve agent settings from Redis
 * Pattern: agent:settings:{agentId}
 *
 * Settings are stored per agentId (e.g., "telegram-6570514069", "slack-g-C12345")
 */
export class AgentSettingsStore extends BaseRedisStore<AgentSettings> {
  private readonly encryptionAvailable: boolean;

  constructor(redis: Redis) {
    super({
      redis,
      keyPrefix: "agent:settings",
      loggerName: "agent-settings-store",
    });

    this.encryptionAvailable = this.canEncryptSensitiveValues();
  }

  /**
   * Get settings for an agent
   * Returns null if no settings configured
   */
  async getSettings(agentId: string): Promise<AgentSettings | null> {
    const key = this.buildKey(agentId);
    try {
      const data = await this.redis.get(key);
      if (!data) {
        return null;
      }

      const parsed = safeJsonParse<AgentSettings>(data);
      if (!parsed) {
        this.logger.warn("Failed to parse agent settings from Redis", { key });
        return null;
      }

      const { settings, needsMigration } =
        this.decryptSettingsForRuntime(parsed);

      if (needsMigration) {
        await this.migrateSettingsInPlace(key, settings, data);
      }

      return settings;
    } catch (error) {
      this.logger.error("Failed to get settings from Redis", {
        error: error instanceof Error ? error.message : String(error),
        key,
      });
      return null;
    }
  }

  /**
   * Get effective settings for an agent, with template agent fallback.
   * For sandbox agents, inherits from the template agent when own settings
   * are missing or have no providers configured.
   */
  async getEffectiveSettings(agentId: string): Promise<AgentSettings | null> {
    const context = await this.getSettingsContext(agentId);
    return context.effectiveSettings;
  }

  async getSettingsContext(agentId: string): Promise<AgentSettingsContext> {
    const localSettings = await this.getSettings(agentId);

    // Resolve template agent ID
    const templateAgentId = await this.resolveTemplateAgentId(
      agentId,
      localSettings
    );
    if (!templateAgentId) {
      return { localSettings, effectiveSettings: localSettings };
    }

    const templateSettings = await this.getSettings(templateAgentId);
    if (!templateSettings) {
      return {
        localSettings,
        effectiveSettings: localSettings,
        templateAgentId,
      };
    }

    // Merge: own settings override template, but inherit missing fields
    if (!localSettings) {
      return {
        localSettings,
        effectiveSettings: { ...templateSettings, templateAgentId },
        templateAgentId,
      };
    }

    return {
      localSettings,
      effectiveSettings: {
        ...templateSettings,
        ...Object.fromEntries(
          Object.entries(localSettings).filter(([, v]) => v !== undefined)
        ),
        templateAgentId,
      } as AgentSettings,
      templateAgentId,
    };
  }

  /**
   * Resolve the template agent ID for a sandbox agent.
   * Chain: settings.templateAgentId → metadata.parentConnectionId → connection.templateAgentId
   */
  private async resolveTemplateAgentId(
    agentId: string,
    settings: AgentSettings | null
  ): Promise<string | undefined> {
    if (settings?.templateAgentId) return settings.templateAgentId;

    try {
      // Check metadata for parentConnectionId
      const metaRaw = await this.redis.get(`agent_metadata:${agentId}`);
      if (!metaRaw) return undefined;
      const meta = safeJsonParse<{ parentConnectionId?: string }>(metaRaw);
      if (!meta?.parentConnectionId) return undefined;

      // Check connection for templateAgentId
      const connRaw = await this.redis.get(
        `connection:${meta.parentConnectionId}`
      );
      if (!connRaw) return undefined;
      const conn = safeJsonParse<{ templateAgentId?: string }>(connRaw);
      return conn?.templateAgentId;
    } catch {
      return undefined;
    }
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
   * Find all sandbox agent IDs that reference a given template agent.
   */
  async findSandboxAgentIds(templateAgentId: string): Promise<string[]> {
    const prefix = `${this.keyPrefix}:`;
    const keys = await this.scanByPrefix(prefix);
    const sandboxIds: string[] = [];

    for (const key of keys) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const parsed = safeJsonParse<AgentSettings>(raw);
        if (parsed?.templateAgentId === templateAgentId) {
          sandboxIds.push(key.slice(prefix.length));
        }
      } catch {
        // Skip unparseable entries
      }
    }

    return sandboxIds;
  }

  /**
   * Check if agent has any settings configured
   */
  async hasSettings(agentId: string): Promise<boolean> {
    const key = this.buildKey(agentId);
    return this.exists(key);
  }

  /**
   * Find the first agent that has installed providers configured.
   * Used to find a template for ephemeral agents.
   */
  async findTemplateAgentId(): Promise<string | null> {
    const prefix = `${this.keyPrefix}:`;
    const keys = await this.scanByPrefix(prefix);
    for (const key of keys) {
      try {
        const data = await this.redis.get(key);
        if (!data) continue;
        const parsed = safeJsonParse<AgentSettings>(data);
        if (
          parsed?.installedProviders &&
          parsed.installedProviders.length > 0
        ) {
          // Extract agentId from key: "agent:settings:{agentId}"
          return key.slice(prefix.length);
        }
      } catch {
        /* skip unparseable key */
      }
    }
    return null;
  }

  protected override serialize(value: AgentSettings): string {
    const encrypted = this.encryptSettingsForStorage(value);
    const json = safeJsonStringify(encrypted);
    if (json === null) {
      throw new Error("Failed to serialize value to JSON");
    }
    return json;
  }

  private canEncryptSensitiveValues(): boolean {
    try {
      const probe = "agent-settings-store-encryption-probe";
      return decrypt(encrypt(probe)) === probe;
    } catch {
      this.logger.warn(
        "ENCRYPTION_KEY not configured or invalid - auth profile credentials will be stored unencrypted"
      );
      return false;
    }
  }

  private async migrateSettingsInPlace(
    key: string,
    settings: AgentSettings,
    originalRaw: string
  ): Promise<void> {
    if (!this.encryptionAvailable) {
      return;
    }

    try {
      await this.redis.watch(key);
      const currentRaw = await this.redis.get(key);
      if (currentRaw !== originalRaw) {
        await this.redis.unwatch();
        this.logger.info(
          "Skipped credentials migration due to concurrent settings update",
          { key }
        );
        return;
      }

      const serialized = this.serialize(settings);
      const result = await this.redis.multi().set(key, serialized).exec();
      if (!result) {
        this.logger.info(
          "Skipped credentials migration due to concurrent settings update",
          { key }
        );
        return;
      }

      this.logger.info(
        "Migrated agent settings credentials to encrypted format",
        {
          key,
        }
      );
    } catch (error) {
      try {
        await this.redis.unwatch();
      } catch {
        // Ignore cleanup failures.
      }
      this.logger.warn(
        "Failed migrating plaintext agent settings credentials",
        {
          error: error instanceof Error ? error.message : String(error),
          key,
        }
      );
    }
  }

  private encryptSettingsForStorage(settings: AgentSettings): AgentSettings {
    let result = settings;

    // Encrypt auth profile credentials
    if (
      Array.isArray(settings.authProfiles) &&
      settings.authProfiles.length > 0
    ) {
      let profilesChanged = false;
      const authProfiles = settings.authProfiles.map((profile) => {
        const encryptedCredential = this.encryptSensitiveValue(
          profile.credential
        );
        const credentialChanged = encryptedCredential !== profile.credential;
        let metadataChanged = false;
        let metadata = profile.metadata;

        if (profile.metadata?.refreshToken) {
          const encryptedRefreshToken = this.encryptSensitiveValue(
            profile.metadata.refreshToken
          );
          if (encryptedRefreshToken !== profile.metadata.refreshToken) {
            metadataChanged = true;
            metadata = {
              ...profile.metadata,
              refreshToken: encryptedRefreshToken,
            };
          }
        }

        if (!credentialChanged && !metadataChanged) {
          return profile;
        }

        profilesChanged = true;
        return {
          ...profile,
          credential: encryptedCredential,
          metadata,
        };
      });

      if (profilesChanged) {
        result = { ...result, authProfiles };
      }
    }

    return result;
  }

  private decryptSettingsForRuntime(settings: AgentSettings): {
    settings: AgentSettings;
    needsMigration: boolean;
  } {
    let result = settings;
    let changed = false;
    let needsMigration = false;

    // Decrypt auth profile credentials
    if (
      Array.isArray(settings.authProfiles) &&
      settings.authProfiles.length > 0
    ) {
      let profilesChanged = false;

      const authProfiles = settings.authProfiles.map((profile) => {
        const credential = this.decryptSensitiveValue(profile.credential);
        let metadata = profile.metadata;
        let metadataChanged = false;

        if (profile.metadata?.refreshToken) {
          const refreshToken = this.decryptSensitiveValue(
            profile.metadata.refreshToken
          );
          if (refreshToken.value !== profile.metadata.refreshToken) {
            metadataChanged = true;
            metadata = {
              ...profile.metadata,
              refreshToken: refreshToken.value,
            };
          }
          needsMigration ||= refreshToken.needsMigration;
        }

        if (credential.value !== profile.credential || metadataChanged) {
          profilesChanged = true;
        }

        needsMigration ||= credential.needsMigration;

        if (!metadataChanged && credential.value === profile.credential) {
          return profile;
        }

        return {
          ...profile,
          credential: credential.value,
          metadata,
        };
      });

      if (profilesChanged) {
        changed = true;
        result = { ...result, authProfiles };
      }
    }

    if (!changed) {
      return { settings, needsMigration };
    }

    return { settings: result, needsMigration };
  }

  private encryptSensitiveValue(value: string): string {
    if (!this.encryptionAvailable) {
      return value;
    }
    if (value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      return value;
    }
    return `${ENCRYPTED_VALUE_PREFIX}${encrypt(value)}`;
  }

  private decryptSensitiveValue(value: string): SensitiveValueDecodeResult {
    if (value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      if (!this.encryptionAvailable) {
        return { value, needsMigration: false };
      }

      try {
        const decrypted = decrypt(value.slice(ENCRYPTED_VALUE_PREFIX.length));
        return { value: decrypted, needsMigration: false };
      } catch (error) {
        this.logger.warn(
          "Dropping undecryptable credential (ENCRYPTION_KEY changed?)",
          { error: error instanceof Error ? error.message : String(error) }
        );
        return { value: "", needsMigration: false };
      }
    }

    if (this.encryptionAvailable && this.looksLikeLegacyEncryptedValue(value)) {
      try {
        const decrypted = decrypt(value);
        return { value: decrypted, needsMigration: true };
      } catch (error) {
        this.logger.warn(
          "Failed to decrypt legacy auth profile credential value",
          {
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return { value, needsMigration: false };
      }
    }

    return {
      value,
      needsMigration: this.encryptionAvailable,
    };
  }

  private looksLikeLegacyEncryptedValue(value: string): boolean {
    const [iv, tag, encrypted, ...rest] = value.split(":");
    if (rest.length > 0) return false;
    if (!iv || !tag || !encrypted) return false;
    return (
      iv.length === 24 &&
      tag.length === 32 &&
      /^[0-9a-f]+$/i.test(iv) &&
      /^[0-9a-f]+$/i.test(tag) &&
      /^[0-9a-f]+$/i.test(encrypted)
    );
  }
}
