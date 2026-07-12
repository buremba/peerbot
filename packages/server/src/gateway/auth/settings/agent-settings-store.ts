import {
  type AgentConfigStore,
  type AgentMetadata,
  type AgentSettings,
  type AuthProfile,
  createLogger,
} from "@lobu/core";
import { orgContext } from "../../../lobu/stores/org-context.js";
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

  /**
   * True when `agentId` is a declared (SDK-embedded) agent whose settings are
   * org-agnostic (no persisted Postgres row). Lets a policy-enforcement read
   * distinguish "declared agent, org not required" from a DB-backed agent that
   * MUST be org-scoped — an orgless DB read of a shared id is a cross-tenant
   * leak.
   */
  isDeclaredAgent(agentId: string): boolean {
    return this.declaredAgents?.has(agentId) ?? false;
  }

  async getSettings(
    agentId: string,
    context?: { organizationId?: string }
  ): Promise<AgentSettings | null> {
    const declared = this.declaredAgents?.get(agentId);

    // DECLARED/DB DISJOINTNESS (cross-tenant): declared (SDK-embedded) settings
    // are org-agnostic. A declared id must NOT shadow a REAL tenant DB row that
    // shares the id — otherwise an org-scoped read of a tenant's agent would be
    // mis-served the declared identity/skills/model. So when an org IS supplied,
    // the org-scoped DB row wins: read it first, and only fall back to the
    // declared overlay when the tenant has NO row for that id. When NO org is
    // supplied, the read is org-agnostic and the declared overlay applies (that
    // is the legitimate orgless declared-agent case).
    if (context?.organizationId) {
      const dbRow = await orgContext.run(
        { organizationId: context.organizationId },
        () => this.configStore.getSettings(agentId)
      );
      if (dbRow) return dbRow;
      return declared ? (declared.settings as AgentSettings) : null;
    }

    if (declared) {
      return declared.settings as AgentSettings;
    }
    return this.configStore.getSettings(agentId);
  }

  /**
   * True when `agentId` resolves to declared (SDK-embedded) settings FOR THIS
   * READ — i.e. it is in the declared registry AND (when an org is given) the
   * tenant has NO persisted DB row that would take precedence. Used by the
   * cross-tenant guard to decide whether an orgless read is safe (declared =
   * org-agnostic) or must be denied (a DB-backed agent with no org). A colliding
   * id that has a real DB row in the given org is NOT treated as declared, so it
   * never flips the orgless guard open.
   */
  async isDeclaredAgentScoped(
    agentId: string,
    organizationId?: string
  ): Promise<boolean> {
    if (!this.declaredAgents?.has(agentId)) return false;
    // No org → org-agnostic declared read; the registry membership is decisive.
    if (!organizationId) return true;
    // Org given → a real tenant DB row takes precedence over the declared
    // overlay, so this id is NOT "declared" for that org (it's DB-backed).
    const dbRow = await orgContext.run({ organizationId }, () =>
      this.configStore.getSettings(agentId)
    );
    return !dbRow;
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
