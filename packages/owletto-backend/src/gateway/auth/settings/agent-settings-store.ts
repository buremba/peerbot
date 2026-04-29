import { type AgentSettings, type AuthProfile, createLogger } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import { tryGetOrgId } from "../../../lobu/stores/org-context.js";
import { InvalidatableCache } from "../../cache/invalidatable-cache.js";
import type { DeclaredAgentRegistry } from "../../services/declared-agent-registry.js";

// Re-export so existing imports from this module keep working.
export type { AgentSettings };

export interface AgentSettingsContext {
  localSettings: AgentSettings | null;
  effectiveSettings: AgentSettings | null;
  templateAgentId?: string;
}

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

function rowToSettings(row: Record<string, any>): AgentSettings {
  return {
    model: row.model ?? undefined,
    modelSelection: row.model_selection ?? undefined,
    providerModelPreferences: row.provider_model_preferences ?? undefined,
    networkConfig: row.network_config ?? undefined,
    nixConfig: row.nix_config ?? undefined,
    mcpServers: row.mcp_servers ?? undefined,
    mcpInstallNotified: row.mcp_install_notified ?? undefined,
    soulMd: row.soul_md ?? undefined,
    userMd: row.user_md ?? undefined,
    identityMd: row.identity_md ?? undefined,
    skillsConfig: row.skills_config ?? undefined,
    toolsConfig: row.tools_config ?? undefined,
    pluginsConfig: row.plugins_config ?? undefined,
    authProfiles: row.auth_profiles ?? undefined,
    installedProviders: row.installed_providers ?? undefined,
    verboseLogging: row.verbose_logging ?? undefined,
    templateAgentId: row.template_agent_id ?? undefined,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : (row.updated_at ?? Date.now()),
  };
}

/**
 * Read agent settings directly from `public.agents`.
 *
 * Worker gateway calls this without orgContext (agent IDs are globally unique
 * and the worker token already proves authenticity), so we fall back to
 * id-only lookup when `tryGetOrgId()` returns null.
 */
async function loadSettingsFromPg(agentId: string): Promise<AgentSettings | null> {
  const sql = getDb();
  const orgId = tryGetOrgId();
  const rows = orgId
    ? await sql`
        SELECT model, model_selection, provider_model_preferences,
               network_config, nix_config, mcp_servers, mcp_install_notified,
               soul_md, user_md, identity_md, skills_config, tools_config,
               plugins_config, auth_profiles, installed_providers,
               verbose_logging, template_agent_id, updated_at
        FROM agents
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `
    : await sql`
        SELECT model, model_selection, provider_model_preferences,
               network_config, nix_config, mcp_servers, mcp_install_notified,
               soul_md, user_md, identity_md, skills_config, tools_config,
               plugins_config, auth_profiles, installed_providers,
               verbose_logging, template_agent_id, updated_at
        FROM agents
        WHERE id = ${agentId}
      `;
  if (rows.length === 0) return null;
  return rowToSettings(rows[0]);
}

/**
 * Per-agent settings reader/writer over `public.agents`.
 *
 * Holds runtime-mutable settings for agents created via the UI or sandbox
 * paths. Declared agents (lobu.toml / SDK config) live in
 * `DeclaredAgentRegistry` and never touch Postgres for settings reads. Auth
 * profiles are owned by `UserAuthProfileStore` keyed by `(userId, agentId)`.
 *
 * Reads go through an InvalidatableCache backed by the `agent_changed`
 * NOTIFY channel, so cache entries drop within milliseconds of any write
 * (from this process or any other gateway instance).
 */
export class AgentSettingsStore {
  private readonly ephemeralAuthProfiles = new EphemeralAuthProfileRegistry();
  private declaredAgents?: DeclaredAgentRegistry;
  private readonly cache: InvalidatableCache<string, AgentSettings | null>;

  constructor() {
    this.cache = new InvalidatableCache<string, AgentSettings | null>({
      channel: "agent_changed",
      ttlMs: 30_000,
      maxEntries: 500,
      loader: (agentId) => loadSettingsFromPg(agentId),
    });
  }

  getEphemeralAuthProfiles(): EphemeralAuthProfileRegistry {
    return this.ephemeralAuthProfiles;
  }

  /**
   * Wire the declared-agent registry so `getEffectiveSettings`
   * returns declared settings for declared agents (which have no
   * persisted Postgres copy by design). Called once from CoreServices
   * after the registry is built.
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
    return this.cache.get(agentId);
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
      // Declared agents are immutable from runtime: no PG local copy,
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
   * Chain: settings.templateAgentId → agents.parent_connection_id → connection.agent_id
   */
  private async resolveTemplateAgentId(
    agentId: string,
    settings: AgentSettings | null
  ): Promise<string | undefined> {
    if (settings?.templateAgentId) return settings.templateAgentId;

    const sql = getDb();
    try {
      const orgId = tryGetOrgId();
      const rows = orgId
        ? await sql`
            SELECT parent_connection_id
            FROM agents
            WHERE id = ${agentId} AND organization_id = ${orgId}
          `
        : await sql`
            SELECT parent_connection_id
            FROM agents
            WHERE id = ${agentId}
          `;
      const parentConnectionId = rows[0]?.parent_connection_id as
        | string
        | undefined;
      if (!parentConnectionId) return undefined;

      const conn = await sql`
        SELECT agent_id FROM agent_connections WHERE id = ${parentConnectionId}
      `;
      return (conn[0]?.agent_id as string | undefined) ?? undefined;
    } catch (error) {
      logger.warn("Failed to resolve template agent id", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async saveSettings(
    agentId: string,
    settings: Omit<AgentSettings, "updatedAt">
  ): Promise<void> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    const now = new Date();

    // Saving settings against an agent that doesn't yet exist is a no-op
    // (the metadata insert in AgentMetadataStore.createAgent must precede
    // settings writes, just like the prior Redis behavior).
    if (orgId) {
      await sql`
        UPDATE agents SET
          model = ${settings.model ?? null},
          model_selection = ${sql.json(settings.modelSelection ?? {})},
          provider_model_preferences = ${sql.json(settings.providerModelPreferences ?? {})},
          network_config = ${sql.json(settings.networkConfig ?? {})},
          nix_config = ${sql.json(settings.nixConfig ?? {})},
          mcp_servers = ${sql.json(settings.mcpServers ?? {})},
          mcp_install_notified = ${sql.json(settings.mcpInstallNotified ?? {})},
          soul_md = ${settings.soulMd ?? ""},
          user_md = ${settings.userMd ?? ""},
          identity_md = ${settings.identityMd ?? ""},
          skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
          tools_config = ${sql.json(settings.toolsConfig ?? {})},
          plugins_config = ${sql.json(settings.pluginsConfig ?? {})},
          auth_profiles = ${sql.json(settings.authProfiles ?? [])},
          installed_providers = ${sql.json(settings.installedProviders ?? [])},
          verbose_logging = ${settings.verboseLogging ?? false},
          template_agent_id = ${settings.templateAgentId ?? null},
          updated_at = ${now}
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
    } else {
      await sql`
        UPDATE agents SET
          model = ${settings.model ?? null},
          model_selection = ${sql.json(settings.modelSelection ?? {})},
          provider_model_preferences = ${sql.json(settings.providerModelPreferences ?? {})},
          network_config = ${sql.json(settings.networkConfig ?? {})},
          nix_config = ${sql.json(settings.nixConfig ?? {})},
          mcp_servers = ${sql.json(settings.mcpServers ?? {})},
          mcp_install_notified = ${sql.json(settings.mcpInstallNotified ?? {})},
          soul_md = ${settings.soulMd ?? ""},
          user_md = ${settings.userMd ?? ""},
          identity_md = ${settings.identityMd ?? ""},
          skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
          tools_config = ${sql.json(settings.toolsConfig ?? {})},
          plugins_config = ${sql.json(settings.pluginsConfig ?? {})},
          auth_profiles = ${sql.json(settings.authProfiles ?? [])},
          installed_providers = ${sql.json(settings.installedProviders ?? [])},
          verbose_logging = ${settings.verboseLogging ?? false},
          template_agent_id = ${settings.templateAgentId ?? null},
          updated_at = ${now}
        WHERE id = ${agentId}
      `;
    }

    // Drop the local cache entry immediately. Other gateway instances see
    // the update through the agents_changed_notify trigger.
    this.cache.invalidate(agentId);
    logger.info(`Saved settings for agent ${agentId}`);
  }

  async updateSettings(
    agentId: string,
    updates: Partial<Omit<AgentSettings, "updatedAt">>
  ): Promise<void> {
    const existing = await loadSettingsFromPg(agentId);
    if (!existing) {
      // Caller expected the row to exist (matches the prior Redis behavior
      // where the Redis SET would create-or-overwrite and saveSettings is
      // used for the create case).
      await this.saveSettings(agentId, updates as Omit<AgentSettings, "updatedAt">);
      return;
    }
    await this.saveSettings(agentId, { ...existing, ...updates });
  }

  async deleteSettings(agentId: string): Promise<void> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    this.ephemeralAuthProfiles.delete(agentId);

    if (orgId) {
      await sql`
        UPDATE agents SET
          model = NULL, model_selection = '{}', provider_model_preferences = '{}',
          network_config = '{}', nix_config = '{}', mcp_servers = '{}',
          mcp_install_notified = '{}', soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}', tools_config = '{}', plugins_config = '{}',
          auth_profiles = '[]', installed_providers = '[]', verbose_logging = false,
          template_agent_id = NULL, updated_at = now()
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
    } else {
      await sql`
        UPDATE agents SET
          model = NULL, model_selection = '{}', provider_model_preferences = '{}',
          network_config = '{}', nix_config = '{}', mcp_servers = '{}',
          mcp_install_notified = '{}', soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}', tools_config = '{}', plugins_config = '{}',
          auth_profiles = '[]', installed_providers = '[]', verbose_logging = false,
          template_agent_id = NULL, updated_at = now()
        WHERE id = ${agentId}
      `;
    }

    this.cache.invalidate(agentId);
    logger.info(`Deleted settings for agent ${agentId}`);
  }

  /**
   * Find all sandbox agent IDs that reference a given template agent.
   */
  async findSandboxAgentIds(templateAgentId: string): Promise<string[]> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    const rows = orgId
      ? await sql`
          SELECT id FROM agents
          WHERE organization_id = ${orgId} AND template_agent_id = ${templateAgentId}
        `
      : await sql`
          SELECT id FROM agents WHERE template_agent_id = ${templateAgentId}
        `;
    return rows.map((row) => row.id as string);
  }

  async hasSettings(agentId: string): Promise<boolean> {
    const settings = await this.getSettings(agentId);
    return settings !== null;
  }

  async close(): Promise<void> {
    await this.cache.close();
  }
}
