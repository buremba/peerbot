import type { AgentSettings, DeclaredCredential } from "@lobu/core";
import { createLogger } from "@lobu/core";
import type { AgentConfig } from "../config/index.js";
import type { FileLoadedAgent } from "../config/file-loader.js";

const logger = createLogger("declared-agent-registry");

interface DeclaredAgentEntry {
  settings: Partial<AgentSettings>;
  credentials: DeclaredCredential[];
}

/**
 * In-memory registry of agents declared by `lobu.toml` (file-loader) or
 * `GatewayConfig.agents` (SDK embedded mode).
 *
 * Declared agents own their settings and credentials at runtime — there is
 * no second copy to drift. The registry is rebuilt wholesale by callers
 * (e.g. `reloadFromFiles`) so removing a provider from `lobu.toml` removes
 * it from the registry on next reload.
 */
export class DeclaredAgentRegistry {
  private readonly entries = new Map<string, DeclaredAgentEntry>();

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  get(agentId: string): DeclaredAgentEntry | undefined {
    return this.entries.get(agentId);
  }

  agentIds(): string[] {
    return Array.from(this.entries.keys());
  }

  entriesList(): Array<[string, DeclaredAgentEntry]> {
    return Array.from(this.entries.entries());
  }

  /** Replace the entire registry. Used at startup and on hot-reload. */
  replaceAll(next: Map<string, DeclaredAgentEntry>): void {
    this.entries.clear();
    for (const [agentId, entry] of next) {
      this.entries.set(agentId, entry);
    }
    logger.debug(`Registry now holds ${this.entries.size} declared agent(s)`);
  }

  /**
   * Find the first declared agent that has installed providers. Used to
   * pick a template for ephemeral/sandbox agents.
   */
  findTemplateAgentId(): string | null {
    for (const [agentId, entry] of this.entries) {
      if (entry.settings.installedProviders?.length) {
        return agentId;
      }
    }
    return null;
  }
}

/**
 * Build a registry entry from a file-loaded agent (lobu.toml).
 */
export function entryFromFileLoadedAgent(
  agent: FileLoadedAgent
): DeclaredAgentEntry {
  return {
    settings: agent.settings,
    credentials: agent.credentials.map((cred) => ({
      provider: cred.provider,
      ...(cred.key ? { key: cred.key } : {}),
      ...(cred.secretRef ? { secretRef: cred.secretRef } : {}),
    })),
  };
}

/**
 * Build a registry entry from an embedded SDK `AgentConfig`. The settings
 * shape mirrors `buildSettingsFromAgentConfig` in `core-services` so the
 * registry can be populated from either source consistently.
 */
export function entryFromAgentConfig(agent: AgentConfig): DeclaredAgentEntry {
  const settings: Partial<AgentSettings> = {};
  if (agent.identityMd) settings.identityMd = agent.identityMd;
  if (agent.soulMd) settings.soulMd = agent.soulMd;
  if (agent.userMd) settings.userMd = agent.userMd;

  if (agent.providers?.length) {
    settings.installedProviders = agent.providers.map((p) => ({
      providerId: p.id,
      installedAt: Date.now(),
    }));
    settings.modelSelection = { mode: "auto" };
    const providerModelPreferences = Object.fromEntries(
      agent.providers
        .filter((p) => !!p.model?.trim())
        .map((p) => [p.id, p.model!.trim()])
    );
    if (Object.keys(providerModelPreferences).length > 0) {
      settings.providerModelPreferences = providerModelPreferences;
    }
  }

  if (agent.skills?.mcp) {
    settings.mcpServers = agent.skills.mcp;
  }

  if (agent.network) {
    settings.networkConfig = {
      allowedDomains: agent.network.allowed,
      deniedDomains: agent.network.denied,
    };
  }

  if (agent.nixPackages?.length) {
    settings.nixConfig = { packages: agent.nixPackages };
  }

  const credentials: DeclaredCredential[] = (agent.providers || [])
    .filter((p) => p.key || p.secretRef)
    .map((p) => ({
      provider: p.id,
      ...(p.key ? { key: p.key } : {}),
      ...(p.secretRef ? { secretRef: p.secretRef } : {}),
    }));

  return { settings, credentials };
}

/**
 * Convenience: build a fresh registry map from a list of file-loaded
 * agents and a list of SDK config agents. Used by `core-services` to
 * populate the registry on startup and on `reloadFromFiles`.
 */
export function buildRegistryMap(
  fileAgents: FileLoadedAgent[],
  configAgents: AgentConfig[]
): Map<string, DeclaredAgentEntry> {
  const result = new Map<string, DeclaredAgentEntry>();
  for (const agent of fileAgents) {
    result.set(agent.agentId, entryFromFileLoadedAgent(agent));
  }
  for (const agent of configAgents) {
    result.set(agent.id, entryFromAgentConfig(agent));
  }
  return result;
}
