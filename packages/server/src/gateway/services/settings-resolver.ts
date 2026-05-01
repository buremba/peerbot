/**
 * SettingsResolver — resolves effective agent settings with template fallback.
 *
 * Extracted from the store layer so sub-stores stay single-domain.
 * Orchestrates across AgentConfigStore (settings + metadata) and
 * AgentConnectionStore (connections) for template resolution.
 */

import type {
  AgentConfigStore,
  AgentConnectionStore,
  AgentSettings,
} from "@lobu/core";

export class SettingsResolver {
  constructor(
    private readonly config: AgentConfigStore,
    private readonly connections: AgentConnectionStore
  ) {}

  /**
   * Get effective settings for an agent, with template agent fallback.
   * For sandbox agents, inherits from the template agent when own settings
   * are missing or have no providers configured.
   */
  async getEffectiveSettings(agentId: string): Promise<AgentSettings | null> {
    const settings = await this.config.getSettings(agentId);

    // If settings exist and have providers, use them directly
    if (settings?.installedProviders?.length) return settings;

    // Resolve template agent ID
    const templateAgentId = await this.resolveTemplateAgentId(
      agentId,
      settings
    );
    if (!templateAgentId) return settings;

    const templateSettings = await this.config.getSettings(templateAgentId);
    if (!templateSettings) return settings;

    // Merge: own settings override template, but inherit missing fields
    if (!settings) {
      return { ...templateSettings, templateAgentId };
    }

    return {
      ...templateSettings,
      ...Object.fromEntries(
        Object.entries(settings).filter(([, v]) => v !== undefined)
      ),
      templateAgentId,
    } as AgentSettings;
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

    const metadata = await this.config.getMetadata(agentId);
    if (!metadata?.parentConnectionId) return undefined;

    const conn = await this.connections.getConnection(
      metadata.parentConnectionId
    );
    return conn?.templateAgentId;
  }
}
