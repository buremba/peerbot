import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AgentConfigStore,
  type AgentSettings,
  createLogger,
  type InstalledProvider,
  type SkillConfig,
} from "@lobu/core";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager";

const logger = createLogger("agent-seeder");

// NOTE: Keep in sync with packages/cli/src/config/agents-manifest.ts
interface ManifestSkill {
  repo: string;
  name: string;
  description?: string;
  instructions?: string;
  content: string;
  enabled: boolean;
  system?: boolean;
  mcpServers?: SkillConfig["mcpServers"];
  nixPackages?: SkillConfig["nixPackages"];
  permissions?: SkillConfig["permissions"];
  providers?: SkillConfig["providers"];
  modelPreference?: SkillConfig["modelPreference"];
  thinkingLevel?: SkillConfig["thinkingLevel"];
}

interface AgentManifestEntry {
  agentId: string;
  name: string;
  description?: string;
  settings: {
    identityMd?: string;
    soulMd?: string;
    userMd?: string;
    installedProviders?: Array<{
      providerId: string;
    }>;
    modelSelection?: AgentSettings["modelSelection"];
    providerModelPreferences?: AgentSettings["providerModelPreferences"];
    nixConfig?: AgentSettings["nixConfig"];
    skillsConfig?: {
      skills: ManifestSkill[];
    };
    networkConfig?: {
      allowedDomains?: string[];
      deniedDomains?: string[];
    };
    mcpServers?: Record<
      string,
      {
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        headers?: Record<string, string>;
        oauth?: {
          authUrl: string;
          tokenUrl: string;
          clientId?: string;
          clientSecret?: string;
          scopes?: string[];
          tokenEndpointAuthMethod?: string;
        };
      }
    >;
  };
  credentials?: Array<{
    providerId: string;
    key: string;
  }>;
  connections?: Array<{
    type: string;
    config: Record<string, string>;
  }>;
}

interface AgentsManifest {
  version: number;
  agents: AgentManifestEntry[];
}

/**
 * Seed agents from .lobu/agents.json using the unified AgentStore.
 */
export async function seedAgentsFromManifest(
  agentStore: AgentConfigStore,
  authProfilesManager?: AuthProfilesManager
): Promise<void> {
  const manifest = loadManifest();
  if (!manifest) return;

  logger.debug(`Seeding ${manifest.agents.length} agent(s) from manifest`);

  for (const entry of manifest.agents) {
    try {
      const existingMetadata = await agentStore.getMetadata(entry.agentId);
      if (!existingMetadata) {
        await agentStore.saveMetadata(entry.agentId, {
          agentId: entry.agentId,
          name: entry.name,
          description: entry.description,
          owner: { platform: "system", userId: "manifest" },
          createdAt: Date.now(),
        });
      } else if (
        existingMetadata.name !== entry.name ||
        existingMetadata.description !== entry.description
      ) {
        await agentStore.updateMetadata(entry.agentId, {
          name: entry.name,
          description: entry.description,
        });
      }

      const existingSettings = await agentStore.getSettings(entry.agentId);
      const nextSettings = buildReconciledSettings(entry, existingSettings);
      const settingsChanged = settingsDiffer(existingSettings, nextSettings);

      if (settingsChanged) {
        await agentStore.saveSettings(entry.agentId, {
          ...nextSettings,
          updatedAt: Date.now(),
        });
        logger.debug(`Reconciled settings for agent "${entry.agentId}"`);
      }

      // Seed provider credentials
      if (authProfilesManager && entry.credentials?.length) {
        for (const cred of entry.credentials) {
          await authProfilesManager.upsertProfile({
            agentId: entry.agentId,
            provider: cred.providerId,
            credential: cred.key,
            authType: "api-key",
            label: `${cred.providerId} (from lobu.toml)`,
            makePrimary: true,
          });
        }
      }

      // NOTE: Connections are NOT seeded here. They go through
      // seedConnectionsFromManifest() → ChatInstanceManager.addConnection()
      // which handles both persistence AND starting the live adapter.
      // That call happens later in startGateway() after ChatInstanceManager is ready.
    } catch (err) {
      logger.error(`Failed to seed agent "${entry.agentId}"`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function loadManifest(): AgentsManifest | null {
  const manifestPath = resolve(process.cwd(), ".lobu/agents.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const manifest = JSON.parse(raw) as AgentsManifest;
    if (!manifest.agents || manifest.agents.length === 0) return null;
    return manifest;
  } catch (err) {
    logger.warn("Failed to parse agents.json", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Seed connections from the manifest after ChatInstanceManager is ready.
 * Skips connections that already exist for the agent on the same platform.
 */
export async function seedConnectionsFromManifest(chatInstanceManager: {
  listConnections(filter?: {
    platform?: string;
    templateAgentId?: string;
  }): Promise<Array<{ platform: string; templateAgentId?: string }>>;
  addConnection(
    platform: string,
    templateAgentId: string | undefined,
    config: any,
    settings?: { allowGroups?: boolean }
  ): Promise<unknown>;
}): Promise<void> {
  const manifestPath = resolve(process.cwd(), ".lobu/agents.json");

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    return;
  }

  let manifest: AgentsManifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return;
  }

  if (!manifest.agents) return;

  for (const entry of manifest.agents) {
    if (!entry.connections?.length) continue;

    for (const conn of entry.connections) {
      // Skip if a connection already exists for this agent + platform
      const existing = await chatInstanceManager.listConnections({
        platform: conn.type,
        templateAgentId: entry.agentId,
      });
      if (existing.length > 0) continue;

      try {
        await chatInstanceManager.addConnection(
          conn.type,
          entry.agentId,
          { platform: conn.type, ...conn.config },
          { allowGroups: true }
        );
        logger.debug(
          `Created ${conn.type} connection for agent "${entry.agentId}"`
        );
      } catch (err) {
        logger.error(
          `Failed to create ${conn.type} connection for agent "${entry.agentId}"`,
          { error: err instanceof Error ? err.message : String(err) }
        );
      }
    }
  }
}

function buildReconciledSettings(
  entry: AgentManifestEntry,
  existing: AgentSettings | null
): Omit<AgentSettings, "updatedAt"> {
  const { updatedAt, ...base } = existing || {};
  const installedProviders = buildInstalledProviders(
    entry.settings.installedProviders,
    existing?.installedProviders
  );
  const skillsConfig = buildSkillsConfig(
    entry.settings.skillsConfig?.skills,
    existing?.skillsConfig?.skills
  );
  const modelSelection = entry.settings.modelSelection;

  return {
    ...base,
    model:
      modelSelection?.mode === "pinned"
        ? modelSelection.pinnedModel
        : undefined,
    modelSelection,
    providerModelPreferences: entry.settings.providerModelPreferences,
    identityMd: entry.settings.identityMd,
    soulMd: entry.settings.soulMd,
    userMd: entry.settings.userMd,
    installedProviders,
    skillsConfig,
    networkConfig: entry.settings.networkConfig,
    nixConfig: entry.settings.nixConfig,
    mcpServers: entry.settings.mcpServers,
  };
}

function buildInstalledProviders(
  manifestProviders: AgentManifestEntry["settings"]["installedProviders"],
  existingProviders: AgentSettings["installedProviders"]
): InstalledProvider[] | undefined {
  if (!manifestProviders) {
    return undefined;
  }

  const manifestIds = new Set(manifestProviders.map((p) => p.providerId));

  const merged: InstalledProvider[] = manifestProviders.map(
    (provider, index) => {
      const existing = existingProviders?.find(
        (candidate) => candidate.providerId === provider.providerId
      );
      return {
        providerId: provider.providerId,
        installedAt: existing?.installedAt ?? Date.now() + index,
        ...(existing?.config ? { config: existing.config } : {}),
      };
    }
  );

  // Preserve providers added via the API that aren't in the manifest
  if (existingProviders) {
    for (const existing of existingProviders) {
      if (!manifestIds.has(existing.providerId)) {
        merged.push(existing);
      }
    }
  }

  return merged;
}

function buildSkillsConfig(
  manifestSkills: ManifestSkill[] | undefined,
  existingSkills: SkillConfig[] | undefined
): AgentSettings["skillsConfig"] {
  if (!manifestSkills) {
    return undefined;
  }

  return {
    skills: manifestSkills.map((skill): SkillConfig => {
      const existing = existingSkills?.find(
        (candidate) =>
          candidate.repo === skill.repo || candidate.name === skill.name
      );
      const contentFetchedAt =
        existing?.content === skill.content && existing.contentFetchedAt
          ? existing.contentFetchedAt
          : skill.content
            ? Date.now()
            : existing?.contentFetchedAt;

      return {
        repo: skill.repo,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        enabled: skill.enabled,
        system: skill.system,
        content: skill.content || undefined,
        contentFetchedAt,
        mcpServers: skill.mcpServers,
        nixPackages: skill.nixPackages,
        permissions: skill.permissions,
        providers: skill.providers,
        modelPreference: skill.modelPreference,
        thinkingLevel: skill.thinkingLevel,
      };
    }),
  };
}

function settingsDiffer(
  existing: AgentSettings | null,
  next: Omit<AgentSettings, "updatedAt">
): boolean {
  if (!existing) {
    return true;
  }

  const { updatedAt, ...current } = existing;
  return stableStringify(current) !== stableStringify(next);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)])
    );
  }

  return value;
}
