import {
  type AgentConfigStore,
  type AgentMetadata,
  type AgentSettings,
  type AuthProfile,
  createLogger,
} from "@lobu/core";
import type { DeclaredAgentRegistry } from "../../services/declared-agent-registry.js";

// Re-export so existing imports from this module keep working.
export type { AgentSettings };

const logger = createLogger("agent-settings-store");

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
 * Per-agent settings reader/writer.
 *
 * Thin overlay over the host's `AgentConfigStore` — the latter owns all
 * Postgres I/O. This class adds two pieces of behaviour the storage layer
 * doesn't need to know about:
 *
 *   1. Declared (SDK-embedded) agents bypass storage entirely; their settings
 *      live in `DeclaredAgentRegistry` and are never persisted.
 *   2. Ephemeral auth profiles (seeded in-memory via `provider.key`) are
 *      tracked here so every `AuthProfilesManager` agrees on which agents
 *      have credentials.
 */
export class AgentSettingsStore {
  private readonly ephemeralAuthProfiles = new EphemeralAuthProfileRegistry();
  private declaredAgents?: DeclaredAgentRegistry;

  constructor(private readonly configStore: AgentConfigStore) {}

  getEphemeralAuthProfiles(): EphemeralAuthProfileRegistry {
    return this.ephemeralAuthProfiles;
  }

  /**
   * Wire the declared-agent registry so `getSettings` returns declared
   * settings for declared agents (which have no persisted Postgres copy by
   * design). Called once from CoreServices after the registry is built.
   */
  setDeclaredAgents(registry: DeclaredAgentRegistry): void {
    this.declaredAgents = registry;
  }

  async getSettings(agentId: string): Promise<AgentSettings | null> {
    const declared = this.declaredAgents?.get(agentId);
    if (declared) {
      return declared.settings as AgentSettings;
    }
    return this.configStore.getSettings(agentId);
  }

  async saveSettings(
    agentId: string,
    settings: Omit<AgentSettings, "updatedAt">
  ): Promise<void> {
    await this.configStore.saveSettings(agentId, {
      ...settings,
      updatedAt: Date.now(),
    });
    logger.info(`Saved settings for agent ${agentId}`);
  }

  async updateSettings(
    agentId: string,
    updates: Partial<Omit<AgentSettings, "updatedAt">>
  ): Promise<void> {
    await this.configStore.updateSettings(agentId, updates);
  }

  async deleteSettings(agentId: string): Promise<void> {
    this.ephemeralAuthProfiles.delete(agentId);
    await this.configStore.deleteSettings(agentId);
    logger.info(`Deleted settings for agent ${agentId}`);
  }

  async hasSettings(agentId: string): Promise<boolean> {
    const settings = await this.getSettings(agentId);
    return settings !== null;
  }

  /** Agent metadata (name, owner, …). Declared agents have no persisted row. */
  async getMetadata(agentId: string): Promise<AgentMetadata | null> {
    if (this.declaredAgents?.get(agentId)) return null;
    return this.configStore.getMetadata(agentId);
  }
}
