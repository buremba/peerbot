import { type AgentSettings, type AuthProfile, createLogger } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import { tryGetOrgId } from "../../../lobu/stores/org-context.js";
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

/** Treat falsy/empty defaults as "not set" so template fallback in
 *  `getSettingsContext` can fill them in from the parent agent. The
 *  `agents` table has DEFAULT '' for the markdown columns and DEFAULT '{}'
 *  for the jsonb settings columns, so a row that was inserted but never had
 *  these fields written would otherwise read as the empty string / object
 *  and shadow the template's value during a merge. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}
function nonEmptyObject<T extends Record<string, unknown>>(
  value: T | null | undefined
): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }
  return Object.keys(value).length > 0 ? value : undefined;
}

/** Build an AgentSettings object that *omits* keys whose stored value is the
 *  empty default. The downstream `resolved-settings-view` uses
 *  `Object.hasOwn(settings, key)` to decide whether the local agent has a
 *  local override vs. inheriting from the template, so we must omit absent
 *  keys rather than including them as undefined. The schema has DEFAULT ''
 *  for markdown columns and DEFAULT '{}'/'[]' for JSONB columns; that's
 *  treated as "not set" here. */
function rowToSettings(row: Record<string, any>): AgentSettings {
  const out: AgentSettings = {
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : (row.updated_at ?? Date.now()),
  };
  if (row.model != null) out.model = row.model;
  const modelSelection = nonEmptyObject(row.model_selection);
  if (modelSelection !== undefined) out.modelSelection = modelSelection as any;
  const providerModelPreferences = nonEmptyObject(row.provider_model_preferences);
  if (providerModelPreferences !== undefined)
    out.providerModelPreferences = providerModelPreferences as any;
  const networkConfig = nonEmptyObject(row.network_config);
  if (networkConfig !== undefined) out.networkConfig = networkConfig as any;
  const nixConfig = nonEmptyObject(row.nix_config);
  if (nixConfig !== undefined) out.nixConfig = nixConfig as any;
  const mcpServers = nonEmptyObject(row.mcp_servers);
  if (mcpServers !== undefined) out.mcpServers = mcpServers as any;
  const mcpInstallNotified = nonEmptyObject(row.mcp_install_notified);
  if (mcpInstallNotified !== undefined)
    out.mcpInstallNotified = mcpInstallNotified as any;
  const soulMd = nonEmptyString(row.soul_md);
  if (soulMd !== undefined) out.soulMd = soulMd;
  const userMd = nonEmptyString(row.user_md);
  if (userMd !== undefined) out.userMd = userMd;
  const identityMd = nonEmptyString(row.identity_md);
  if (identityMd !== undefined) out.identityMd = identityMd;
  // skillsConfig has the shape `{ skills: [] }` by default; treat the empty
  // skills array as "not set" so the template's skillsConfig wins.
  const skillsConfig = row.skills_config;
  if (
    skillsConfig &&
    Array.isArray(skillsConfig.skills) &&
    skillsConfig.skills.length > 0
  ) {
    out.skillsConfig = skillsConfig;
  }
  const toolsConfig = nonEmptyObject(row.tools_config);
  if (toolsConfig !== undefined) out.toolsConfig = toolsConfig as any;
  const pluginsConfig = nonEmptyObject(row.plugins_config);
  if (pluginsConfig !== undefined) out.pluginsConfig = pluginsConfig as any;
  const authProfiles = nonEmptyObject(row.auth_profiles);
  if (authProfiles !== undefined) out.authProfiles = authProfiles as any;
  const installedProviders = nonEmptyObject(row.installed_providers);
  if (installedProviders !== undefined)
    out.installedProviders = installedProviders as any;
  if (row.verbose_logging) out.verboseLogging = true;
  if (row.template_agent_id) out.templateAgentId = row.template_agent_id;
  return out;
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
 */
export class AgentSettingsStore {
  private readonly ephemeralAuthProfiles = new EphemeralAuthProfileRegistry();
  private declaredAgents?: DeclaredAgentRegistry;

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
    return loadSettingsFromPg(agentId);
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

}
