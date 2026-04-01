#!/usr/bin/env bun

import {
  buildUnconfiguredAgentNotice,
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@lobu/core";
import type { McpConfigService } from "../auth/mcp/config-service";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store";

const logger = createLogger("instruction-service");

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
}

interface SessionContextData {
  agentInstructions: string;
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

      // Progressive disclosure: inject only metadata (name + description + model/thinking tags)
      // to reduce prompt size. Agent reads full SKILL.md on demand.
      const skillSummaries = enabledSkills
        .map((skill) => {
          const desc = skill.description ? ` - ${skill.description}` : "";
          const tags: string[] = [];
          if (skill.modelPreference) {
            tags.push(`[model: ${skill.modelPreference}]`);
          }
          if (skill.thinkingLevel) {
            tags.push(`[thinking: ${skill.thinkingLevel}]`);
          }
          const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";
          const line = `- **${skill.name}**${desc} (\`${skill.repo}\`)${tagStr}`;
          if (skill.instructions?.trim()) {
            return `${line}\n  → ${skill.instructions.trim()}`;
          }
          return line;
        })
        .join("\n");

      return `# Enabled Skills

The following skills are installed and available. When a task matches a skill, read the full skill instructions before using it. Skills tagged with [model: ...] prefer a specific model — delegate to the corresponding coding agent when available.

${skillSummaries}

**To read full skill instructions:** \`cat .skills/*/SKILL.md\` to read the relevant SKILL.md file.

---

${this.getGenericSkillsInstructions()}`;
    } catch (error) {
      logger.error("Failed to get skills instructions", { error });
      return this.getGenericSkillsInstructions();
    }
  }

  private getGenericSkillsInstructions(): string {
    return `## Skills

You can extend your capabilities by searching for installable skills and MCP servers with the built-in tools.

**Available tools:**
- \`SearchSkills\` - Search for skills and MCP servers by keyword
- \`InstallSkill\` - Install or upgrade a skill or MCP server from search results

When the user asks about adding capabilities, finding tools, or extending functionality, search for relevant skills first using \`SearchSkills\`.`;
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

You do NOT have access to the internet. All external requests (curl, wget, npm, pip, etc.) will fail. If you need network access, use RequestNetworkAccess to request it — this presents inline approval buttons to the user. Only local operations and MCP tools are available.`;
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

You can only access the allowed domains listed above. All other external requests will be blocked by the proxy. If a domain is blocked, use RequestNetworkAccess to request access — this presents inline approval buttons to the user (default grant: 1 hour). Plan your work accordingly and use available MCP tools when possible.`;

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
  private agentSettingsStore?: AgentSettingsStore;
  private skillsProvider: SkillsInstructionProvider;

  constructor(
    mcpConfigService?: McpConfigService,
    agentSettingsStore?: AgentSettingsStore
  ) {
    this.mcpConfigService = mcpConfigService;
    this.agentSettingsStore = agentSettingsStore;
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
   */
  async getSessionContext(
    platform: string,
    context: InstructionContext,
    options?: { settingsUrl?: string }
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

    // Build agent instructions from identity/soul/user settings
    let agentInstructions = "";
    if (this.agentSettingsStore && context.agentId) {
      try {
        const settings = await this.agentSettingsStore.getSettings(
          context.agentId
        );
        if (settings) {
          const sections: string[] = [];
          if (settings.identityMd?.trim()) {
            sections.push(`## Agent Identity\n\n${settings.identityMd.trim()}`);
          }
          if (settings.soulMd?.trim()) {
            sections.push(`## Agent Instructions\n\n${settings.soulMd.trim()}`);
          }
          if (settings.userMd?.trim()) {
            sections.push(`## User Context\n\n${settings.userMd.trim()}`);
          }
          agentInstructions = sections.join("\n\n");
        }

        // When soul is unconfigured, tell the agent about its settings page
        if (!agentInstructions.trim()) {
          agentInstructions = buildUnconfiguredAgentNotice(
            options?.settingsUrl
          );
        }

        logger.info(
          `Built agent instructions (${agentInstructions.length} chars)`
        );
      } catch (error) {
        logger.error("Failed to build agent instructions:", error);
      }
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
      agentInstructions,
      platformInstructions,
      networkInstructions,
      skillsInstructions,
      mcpStatus,
    };
  }
}
