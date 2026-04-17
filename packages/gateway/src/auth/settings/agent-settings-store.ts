import {
  type AgentSettings,
  type AuthProfile,
  BaseRedisStore,
  safeJsonParse,
  safeJsonStringify,
} from "@lobu/core";
import type Redis from "ioredis";
import type { DeclaredAgentRegistry } from "../../services/declared-agent-registry";

// Re-export so existing imports from this module keep working.
export type { AgentSettings };

export interface AgentSettingsContext {
  localSettings: AgentSettings | null;
  effectiveSettings: AgentSettings | null;
  templateAgentId?: string;
}

/**
 * Shared in-memory ephemeral auth profile registry. Lives on
 * AgentSettingsStore because it's the single shared instance every
 * `AuthProfilesManager` (including the ones each provider module constructs)
 * is built against. Storing the map here keeps all managers in sync — a
 * must-have for SDK-embedded use where `provider.key` seeds a credential on
 * the central manager and a provider module later asks "does this agent have
 * credentials?".
 */
export class EphemeralAuthProfileRegistry {
  private readonly profiles = new Map<string, AuthProfile[]>();

  get(agentId: string): AuthProfile[] | undefined {
    return this.profiles.get(agentId);
  }

  set(agentId: string, profiles: AuthProfile[]): void {
    this.profiles.set(agentId, profiles);
  }

  delete(agentId: string): void {
    this.profiles.delete(agentId);
  }
}

/**
 * Store and retrieve agent settings from Redis
 * Pattern: agent:settings:{agentId}
 *
 * Holds runtime-mutable settings for agents created via the UI or sandbox
 * paths. Declared agents (lobu.toml / SDK config) live in
 * `DeclaredAgentRegistry` and never touch Redis. Auth profiles are owned
 * by `UserAuthProfileStore` keyed by `(userId, agentId)`.
 */
export class AgentSettingsStore extends BaseRedisStore<AgentSettings> {
  private readonly ephemeralAuthProfiles = new EphemeralAuthProfileRegistry();
  private declaredAgents?: DeclaredAgentRegistry;

  constructor(redis: Redis) {
    super({
      redis,
      keyPrefix: "agent:settings",
      loggerName: "agent-settings-store",
    });
  }

  getEphemeralAuthProfiles(): EphemeralAuthProfileRegistry {
    return this.ephemeralAuthProfiles;
  }

  /**
   * Wire the declared-agent registry so `getEffectiveSettings`
   * returns declared settings for declared agents (which never have a
   * Redis copy by design). Called once from CoreServices after the
   * registry is built.
   */
  setDeclaredAgents(registry: DeclaredAgentRegistry): void {
    this.declaredAgents = registry;
  }

  /**
   * Get raw settings for an agent. Sensitive values are returned as refs;
   * callers that need plaintext must resolve them through the secret store
   * (e.g., via AuthProfilesManager.listProfiles).
   */
  async getSettings(agentId: string): Promise<AgentSettings | null> {
    const key = this.buildKey(agentId);
    try {
      const data = await this.redis.get(key);
      if (!data) return null;

      const parsed = safeJsonParse<AgentSettings>(data);
      if (!parsed) {
        this.logger.warn("Failed to parse agent settings from Redis", { key });
        return null;
      }
      return parsed;
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
    const declared = this.declaredAgents?.get(agentId);
    if (declared) {
      // Declared agents are immutable from runtime: no Redis local copy,
      // no template fallback. Return registry settings as effective.
      return {
        localSettings: null,
        effectiveSettings: declared.settings as AgentSettings,
      };
    }

    const localSettings = await this.getSettings(agentId);

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
      const metaRaw = await this.redis.get(`agent_metadata:${agentId}`);
      if (!metaRaw) return undefined;
      const meta = safeJsonParse<{ parentConnectionId?: string }>(metaRaw);
      if (!meta?.parentConnectionId) return undefined;

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

  async saveSettings(
    agentId: string,
    settings: Omit<AgentSettings, "updatedAt">
  ): Promise<void> {
    const key = this.buildKey(agentId);
    await this.set(key, { ...settings, updatedAt: Date.now() });
    this.logger.info(`Saved settings for agent ${agentId}`);
  }

  async updateSettings(
    agentId: string,
    updates: Partial<Omit<AgentSettings, "updatedAt">>
  ): Promise<void> {
    const existing = await this.getSettings(agentId);
    const key = this.buildKey(agentId);
    await this.set(key, { ...existing, ...updates, updatedAt: Date.now() });
    this.logger.info(`Updated settings for agent ${agentId}`);
  }

  async deleteSettings(agentId: string): Promise<void> {
    const key = this.buildKey(agentId);
    this.ephemeralAuthProfiles.delete(agentId);
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

  async hasSettings(agentId: string): Promise<boolean> {
    const key = this.buildKey(agentId);
    return this.exists(key);
  }

  protected override serialize(value: AgentSettings): string {
    const json = safeJsonStringify(value);
    if (json === null) {
      throw new Error("Failed to serialize value to JSON");
    }
    return json;
  }
}
