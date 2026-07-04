import type { AgentSettings, DeclaredCredential } from "@lobu/core";
import { createLogger } from "@lobu/core";
import type { AgentConfig } from "../config/index.js";

const logger = createLogger("declared-agent-registry");

interface DeclaredAgentEntry {
  settings: Partial<AgentSettings>;
  credentials: DeclaredCredential[];
}

/**
 * In-memory registry of agents declared by `GatewayConfig.agents` when the
 * gateway is embedded as a library (SDK-mode).
 *
 * `lobu.config.ts` is no longer read at gateway boot — file-declared agents
 * enter Postgres via `lobu apply` and are read through `AgentConfigStore`.
 *
 * Declared agents own their settings and credentials at runtime — there is
 * no second copy to drift.
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
}

/**
 * Build a registry entry from an embedded SDK `AgentConfig`. The settings
 * shape mirrors `buildSettingsFromAgentConfig` in `core-services`.
 */
export function entryFromAgentConfig(agent: AgentConfig): DeclaredAgentEntry {
  const settings: Partial<AgentSettings> = {};
  if (agent.identityMd) settings.identityMd = agent.identityMd;
  if (agent.soulMd) settings.soulMd = agent.soulMd;
  if (agent.userMd) settings.userMd = agent.userMd;

  if (agent.providers?.length) {
    // installedProviders stays the credential/catalog list (routes org
    // providers). The agent's model collapses to a single defaultModel: the
    // primary provider's declared model, or "<providerId>/auto" so the worker
    // resolves that provider's newest live model.
    settings.installedProviders = agent.providers.map((p) => ({
      providerId: p.id,
      installedAt: Date.now(),
    }));
    const primary = agent.providers[0];
    const primaryModel = primary.model?.trim();
    settings.defaultModel = primaryModel || `${primary.id}/auto`;
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
 * Build a fresh registry map from a list of SDK config agents. Used by
 * `core-services` on startup.
 */
export function buildRegistryMap(
  configAgents: AgentConfig[]
): Map<string, DeclaredAgentEntry> {
  const result = new Map<string, DeclaredAgentEntry>();
  for (const agent of configAgents) {
    result.set(agent.id, entryFromAgentConfig(agent));
  }
  return result;
}
