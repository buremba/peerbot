import { type AgentSettings, type AuthProfile, createLogger } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import { tryGetOrgId } from "../../../lobu/stores/org-context.js";
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

/** Read row directly. Empty/default JSONB columns are passed through as-is —
 *  there is no overlay anymore, so nothing depends on "absent vs default". */
function rowToSettings(row: Record<string, any>): AgentSettings {
  return {
    model: row.model ?? undefined,
    modelSelection: row.model_selection ?? undefined,
    providerModelPreferences: row.provider_model_preferences ?? undefined,
    networkConfig: row.network_config ?? undefined,
    nixConfig: row.nix_config ?? undefined,
    mcpServers: row.mcp_servers ?? undefined,
    soulMd: row.soul_md ?? "",
    userMd: row.user_md ?? "",
    identityMd: row.identity_md ?? "",
    skillsConfig: row.skills_config ?? undefined,
    toolsConfig: row.tools_config ?? undefined,
    pluginsConfig: row.plugins_config ?? undefined,
    installedProviders: row.installed_providers ?? undefined,
    verboseLogging: row.verbose_logging ?? undefined,
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
               network_config, nix_config, mcp_servers,
               soul_md, user_md, identity_md, skills_config, tools_config,
               plugins_config, installed_providers,
               verbose_logging, updated_at
        FROM agents
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `
    : await sql`
        SELECT model, model_selection, provider_model_preferences,
               network_config, nix_config, mcp_servers,
               soul_md, user_md, identity_md, skills_config, tools_config,
               plugins_config, installed_providers,
               verbose_logging, updated_at
        FROM agents
        WHERE id = ${agentId}
      `;
  if (rows.length === 0) return null;
  return rowToSettings(rows[0]);
}

/**
 * Per-agent settings reader/writer over `public.agents`.
 *
 * Holds runtime-mutable settings for agents created via the UI. Declared
 * agents (lobu.toml / SDK config) live in `DeclaredAgentRegistry` and never
 * touch Postgres for settings reads. Auth profiles are owned by
 * `UserAuthProfileStore` keyed by `(userId, agentId)`.
 */
export class AgentSettingsStore {
  private readonly ephemeralAuthProfiles = new EphemeralAuthProfileRegistry();
  private declaredAgents?: DeclaredAgentRegistry;

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
   * Get raw settings for an agent. Sensitive values are returned as refs;
   * callers that need plaintext must resolve them through the secret store
   * (e.g., via AuthProfilesManager.listProfiles).
   */
  async getSettings(agentId: string): Promise<AgentSettings | null> {
    const declared = this.declaredAgents?.get(agentId);
    if (declared) {
      return declared.settings as AgentSettings;
    }
    return loadSettingsFromPg(agentId);
  }

  async saveSettings(
    agentId: string,
    settings: Omit<AgentSettings, "updatedAt">
  ): Promise<void> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    const now = new Date();

    // Saving settings against an agent that doesn't yet exist is a no-op:
    // the metadata insert in AgentMetadataStore.createAgent must precede
    // settings writes.
    if (orgId) {
      await sql`
        UPDATE agents SET
          model = ${settings.model ?? null},
          model_selection = ${sql.json(settings.modelSelection ?? {})},
          provider_model_preferences = ${sql.json(settings.providerModelPreferences ?? {})},
          network_config = ${sql.json(settings.networkConfig ?? {})},
          nix_config = ${sql.json(settings.nixConfig ?? {})},
          mcp_servers = ${sql.json(settings.mcpServers ?? {})},
          soul_md = ${settings.soulMd ?? ""},
          user_md = ${settings.userMd ?? ""},
          identity_md = ${settings.identityMd ?? ""},
          skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
          tools_config = ${sql.json(settings.toolsConfig ?? {})},
          plugins_config = ${sql.json(settings.pluginsConfig ?? {})},
          installed_providers = ${sql.json(settings.installedProviders ?? [])},
          verbose_logging = ${settings.verboseLogging ?? false},
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
          soul_md = ${settings.soulMd ?? ""},
          user_md = ${settings.userMd ?? ""},
          identity_md = ${settings.identityMd ?? ""},
          skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
          tools_config = ${sql.json(settings.toolsConfig ?? {})},
          plugins_config = ${sql.json(settings.pluginsConfig ?? {})},
          installed_providers = ${sql.json(settings.installedProviders ?? [])},
          verbose_logging = ${settings.verboseLogging ?? false},
          updated_at = ${now}
        WHERE id = ${agentId}
      `;
    }

    logger.info(`Saved settings for agent ${agentId}`);
  }

  async updateSettings(
    agentId: string,
    updates: Partial<Omit<AgentSettings, "updatedAt">>
  ): Promise<void> {
    const existing = await loadSettingsFromPg(agentId);
    if (!existing) {
      // No row yet — fall through to saveSettings, which create-or-overwrites.
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
          soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}', tools_config = '{}', plugins_config = '{}',
          installed_providers = '[]', verbose_logging = false,
          updated_at = now()
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
    } else {
      await sql`
        UPDATE agents SET
          model = NULL, model_selection = '{}', provider_model_preferences = '{}',
          network_config = '{}', nix_config = '{}', mcp_servers = '{}',
          soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}', tools_config = '{}', plugins_config = '{}',
          installed_providers = '[]', verbose_logging = false,
          updated_at = now()
        WHERE id = ${agentId}
      `;
    }

    logger.info(`Deleted settings for agent ${agentId}`);
  }

  async hasSettings(agentId: string): Promise<boolean> {
    const settings = await this.getSettings(agentId);
    return settings !== null;
  }

}
