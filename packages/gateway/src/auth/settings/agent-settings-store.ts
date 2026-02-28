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
  /** Network access configuration */
  networkConfig?: NetworkConfig;
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
  /** Ordered auth profiles (index 0 = primary). Used for multi-provider credential management. */
  authProfiles?: AuthProfile[];
  /** Installed providers for this agent (index 0 = primary). */
  installedProviders?: InstalledProvider[];
  /** Enable verbose logging (show tool calls, reasoning, etc.) */
  verboseLogging?: boolean;
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
    if (
      !Array.isArray(settings.authProfiles) ||
      settings.authProfiles.length === 0
    ) {
      return settings;
    }

    let changed = false;
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

      changed = true;
      return {
        ...profile,
        credential: encryptedCredential,
        metadata,
      };
    });

    if (!changed) {
      return settings;
    }

    return {
      ...settings,
      authProfiles,
    };
  }

  private decryptSettingsForRuntime(settings: AgentSettings): {
    settings: AgentSettings;
    needsMigration: boolean;
  } {
    if (
      !Array.isArray(settings.authProfiles) ||
      settings.authProfiles.length === 0
    ) {
      return { settings, needsMigration: false };
    }

    let changed = false;
    let needsMigration = false;

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
        changed = true;
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

    if (!changed) {
      return { settings, needsMigration };
    }

    return {
      settings: {
        ...settings,
        authProfiles,
      },
      needsMigration,
    };
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
        this.logger.warn("Failed to decrypt auth profile credential value", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { value, needsMigration: false };
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
