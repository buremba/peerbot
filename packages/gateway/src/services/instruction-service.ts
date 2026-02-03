#!/usr/bin/env bun

import {
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@peerbot/core";
import type { McpConfigService } from "../auth/mcp/config-service";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store";

const logger = createLogger("instruction-service");

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
  authenticated: boolean;
  configured: boolean;
}

interface SessionContextData {
  platformInstructions: string;
  networkInstructions: string;
  skillsInstructions: string;
  mcpStatus: McpStatus[];
}

/**
 * Provides instructions from enabled skills for the agent.
 * Fetches skill content from AgentSettings and injects as instructions.
 * Falls back to generic skills.sh discovery instructions if no skills configured.
 */
class SkillsInstructionProvider implements InstructionProvider {
  name = "skills";
  priority = 15;

  constructor(private agentSettingsStore?: AgentSettingsStore) {}

  async getInstructions(context: InstructionContext): Promise<string> {
    // If no settings store or agentId, return generic skills.sh instructions
    if (!this.agentSettingsStore || !context.agentId) {
      return this.getGenericSkillsInstructions();
    }

    try {
      const settings = await this.agentSettingsStore.getSettings(
        context.agentId
      );
      const skills = settings?.skillsConfig?.skills || [];
      const enabledSkills = skills.filter((s) => s.enabled && s.content);

      if (enabledSkills.length === 0) {
        return this.getGenericSkillsInstructions();
      }

      // Build skill instructions from enabled skills
      const skillInstructions = enabledSkills
        .map((skill) => {
          return `## Skill: ${skill.name}\n\n${skill.content}`;
        })
        .join("\n\n---\n\n");

      return `# Enabled Skills

The following skills are enabled for this agent. Follow their instructions when relevant.

${skillInstructions}

---

${this.getGenericSkillsInstructions()}`;
    } catch (error) {
      logger.error("Failed to get skills instructions", { error });
      return this.getGenericSkillsInstructions();
    }
  }

  private getGenericSkillsInstructions(): string {
    return `## Skills

You can extend your capabilities by installing skills from [skills.sh](https://skills.sh), an open ecosystem of agent skills.

**Available commands:**
- \`npx skills find [query]\` - Search for skills interactively or by keyword
- \`npx skills add owner/repo -g -y\` - Install a skill globally
- \`npx skills check\` - Check installed skills for updates
- \`npx skills update\` - Update all skills to latest versions

When the user asks about adding capabilities, finding tools, or extending functionality, search for relevant skills first using \`npx skills find\`.`;
  }
}

/**
 * Provides information about network access rules and allowed domains
 */
class NetworkInstructionProvider implements InstructionProvider {
  name = "network";
  priority = 20;

  getInstructions(_context: InstructionContext): string {
    const allowedDomains = process.env.WORKER_ALLOWED_DOMAINS?.trim() || "";
    const disallowedDomains =
      process.env.WORKER_DISALLOWED_DOMAINS?.trim() || "";

    // Unrestricted mode
    if (allowedDomains === "*") {
      if (disallowedDomains) {
        const blockedList = disallowedDomains
          .split(",")
          .map((d) => `  - ${d.trim()}`)
          .filter((d) => d.length > 4)
          .join("\n");
        return `## Network Access

**Internet Access:** Unrestricted (all domains allowed)

**Blocked domains:**
${blockedList}

You can access any external service except the blocked domains listed above.`;
      }
      return `## Network Access

**Internet Access:** Unrestricted (all domains allowed)

You can access any external service without restrictions.`;
    }

    // Complete isolation
    if (!allowedDomains) {
      return `## Network Access

**Internet Access:** Complete isolation (no external access)

You do NOT have access to the internet. All external requests (curl, wget, npm, pip, etc.) will fail. Only local operations and MCP tools are available.`;
    }

    // Allowlist mode
    const allowedList = allowedDomains
      .split(",")
      .map((d) => `  - ${d.trim()}`)
      .filter((d) => d.length > 4)
      .join("\n");

    let instructions = `## Network Access

**Internet Access:** Filtered (allowlist mode)

**Allowed domains:**
${allowedList}`;

    if (disallowedDomains) {
      const blockedList = disallowedDomains
        .split(",")
        .map((d) => `  - ${d.trim()}`)
        .filter((d) => d.length > 4)
        .join("\n");
      instructions += `

**Blocked domains:**
${blockedList}`;
    }

    instructions += `

You can only access the allowed domains listed above. All other external requests will be blocked by the proxy. Plan your work accordingly and use available MCP tools when possible.`;

    return instructions;
  }
}

/**
 * Aggregates session context data for workers
 * Returns raw data (not built instructions) so workers can format as needed
 */
export class InstructionService {
  private platformProviders = new Map<string, InstructionProvider>();
  private mcpConfigService?: McpConfigService;
  private skillsProvider: SkillsInstructionProvider;

  constructor(
    mcpConfigService?: McpConfigService,
    agentSettingsStore?: AgentSettingsStore
  ) {
    this.mcpConfigService = mcpConfigService;
    this.skillsProvider = new SkillsInstructionProvider(agentSettingsStore);
  }

  /**
   * Register a platform-specific instruction provider
   * Called by platform adapters during initialization
   */
  registerPlatformProvider(
    platform: string,
    provider: InstructionProvider
  ): void {
    this.platformProviders.set(platform, provider);
    logger.info(
      `Registered instruction provider for platform: ${platform} (${provider.name})`
    );
  }

  /**
   * Get session context data for a worker
   * Returns platform instructions and MCP status data
   * Worker will build final instructions from this data
   */
  async getSessionContext(
    platform: string,
    context: InstructionContext
  ): Promise<SessionContextData> {
    // Get platform-specific instructions
    let platformInstructions = "";
    const platformProvider = this.platformProviders.get(platform);
    if (platformProvider) {
      try {
        platformInstructions = await platformProvider.getInstructions(context);
        logger.info(
          `Got ${platform} platform instructions (${platformInstructions.length} chars)`
        );
      } catch (error) {
        logger.error(
          `Failed to get instructions from ${platform} provider:`,
          error
        );
      }
    }

    // Get network access instructions
    let networkInstructions = "";
    const networkProvider = new NetworkInstructionProvider();
    try {
      networkInstructions = await networkProvider.getInstructions(context);
      logger.info(
        `Got network instructions (${networkInstructions.length} chars)`
      );
    } catch (error) {
      logger.error("Failed to get network instructions:", error);
    }

    // Get skills instructions (includes enabled skills from agent settings)
    let skillsInstructions = "";
    try {
      skillsInstructions = await this.skillsProvider.getInstructions(context);
      logger.info(
        `Got skills instructions (${skillsInstructions.length} chars)`
      );
    } catch (error) {
      logger.error("Failed to get skills instructions:", error);
    }

    // Get MCP status data
    let mcpStatus: McpStatus[] = [];
    if (this.mcpConfigService) {
      try {
        mcpStatus =
          (await this.mcpConfigService.getMcpStatus(context.agentId)) || [];
        logger.info(`Got MCP status for ${mcpStatus.length} MCPs`);
      } catch (error) {
        logger.error("Failed to get MCP status:", error);
      }
    }

    return {
      platformInstructions,
      networkInstructions,
      skillsInstructions,
      mcpStatus,
    };
  }
}
