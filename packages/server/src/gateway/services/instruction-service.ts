#!/usr/bin/env bun

import {
  buildUnconfiguredAgentNotice,
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@lobu/core";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";

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
 * Shared base class for InstructionProviders.
 *
 * Subclasses implement `buildInstructions(context)` with their domain logic.
 * The base wraps every call in a try-catch + structured logging, so unexpected
 * errors yield an empty string instead of crashing the session context
 * assembly. This removes the identical boilerplate each subclass used to
 * declare.
 */
export abstract class BaseInstructionProvider implements InstructionProvider {
  abstract readonly name: string;
  abstract readonly priority: number;

  async getInstructions(context: InstructionContext): Promise<string> {
    try {
      return await this.buildInstructions(context);
    } catch (error) {
      logger.error(`Failed to build ${this.name} instructions`, { error });
      return "";
    }
  }

  protected abstract buildInstructions(
    context: InstructionContext
  ): Promise<string> | string;
}

/**
 * Provides instructions from enabled skills for the agent.
 * Fetches skill content from AgentSettings and injects as instructions.
 * Falls back to generic skills.sh discovery instructions if no skills configured.
 */
class SkillsInstructionProvider extends BaseInstructionProvider {
  readonly name = "skills";
  readonly priority = 15;

  constructor(private agentSettingsStore?: AgentSettingsStore) {
    super();
  }

  protected async buildInstructions(
    context: InstructionContext
  ): Promise<string> {
    // If no settings store or agentId, return generic skills.sh instructions
    if (!this.agentSettingsStore || !context.agentId) {
      return this.getGenericSkillsInstructions();
    }

    // Settings lookup uses a local try/catch because the domain-specific
    // fallback here is "return the generic skills blurb", not "empty string".
    // The base class's catch-all still guards against any bug outside this
    // block.
    let enabledSkills: Array<{
      name: string;
      description?: string;
      repo: string;
      content?: string;
      modelPreference?: string;
      thinkingLevel?: string;
      instructions?: string;
    }> = [];
    try {
      const settings = await this.agentSettingsStore.getSettings(
        context.agentId
      );
      const skills = settings?.skillsConfig?.skills || [];
      enabledSkills = skills.filter((s) => s.enabled && s.content);
    } catch (error) {
      logger.error("Failed to load skill settings", { error });
      return this.getGenericSkillsInstructions();
    }

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
  }

  private getGenericSkillsInstructions(): string {
    return `## Skills

Your available skills are listed above. To read full instructions for a skill, use: \`cat .skills/{skillName}/SKILL.md\``;
  }
}

/**
 * Provides information about network access rules and allowed domains
 */
class NetworkInstructionProvider extends BaseInstructionProvider {
  readonly name = "network";
  readonly priority = 20;

  protected buildInstructions(_context: InstructionContext): string {
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

You do NOT have access to the internet. All external requests (curl, wget, npm, pip, etc.) will fail. Network access is configured via lobu.toml or the gateway configuration APIs. Only local operations and MCP tools are available.`;
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

You can only access the allowed domains listed above. All other external requests will be blocked by the proxy. Network access is configured via lobu.toml or the gateway configuration APIs. Plan your work accordingly and use available MCP tools when possible.`;

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

        // When soul is unconfigured, tell the agent to defer to admin config.
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
