import { readFile } from "node:fs/promises";
import type {
  ProviderConfigEntry,
  SkillConfig,
  SystemSkillEntry,
  SystemSkillsConfigFile,
} from "@lobu/core";
import { createLogger } from "@lobu/core";

const logger = createLogger("system-skills-service");

// Block sensitive env vars from ${env:VAR} substitution in system skills config
const ENV_SUBSTITUTION_BLOCKLIST = new Set([
  "ENCRYPTION_KEY",
  "ADMIN_PASSWORD",
  "DATABASE_PASSWORD",
  "DATABASE_URL",
  "REDIS_URL",
  "REDIS_PASSWORD",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "SENTRY_DSN",
]);

export interface RuntimeSystemSkill {
  id: string;
  repo: string;
  name: string;
  description?: string;
  instructions?: string;
  content: string;
}

export class SystemSkillsService {
  private configUrl?: string;
  private loaded?: SystemSkillsConfigFile;
  private rawLoaded?: SystemSkillsConfigFile;
  private loadAttempted = false;

  constructor(configUrl?: string, preloadedSkills?: SystemSkillEntry[]) {
    this.configUrl = configUrl;
    if (preloadedSkills) {
      const config: SystemSkillsConfigFile = { skills: preloadedSkills };
      this.loaded = config;
      this.rawLoaded = config;
      logger.info(
        `Loaded ${preloadedSkills.length} system skill(s) (injected)`
      );
    }
  }

  async getSystemSkills(): Promise<SkillConfig[]> {
    const config = await this.loadConfig();
    if (!config) return [];
    return config.skills.map((entry) => this.toSkillConfig(entry));
  }

  /**
   * Returns only skills that are discoverable via search.
   * Filters out entries with `hidden: true` (e.g. Owletto which is embedded).
   */
  async getSearchableSkills(): Promise<SkillConfig[]> {
    const config = await this.loadConfig();
    if (!config) return [];
    return config.skills
      .filter((entry) => !entry.hidden)
      .map((entry) => this.toSkillConfig(entry));
  }

  /**
   * Returns skills with original ${env:*} patterns intact (not substituted).
   * Used by the admin env catalog to discover which env vars are referenced.
   */
  async getRawSystemSkills(): Promise<SkillConfig[]> {
    await this.loadConfig();
    if (!this.rawLoaded) return [];
    return this.rawLoaded.skills.map((entry) => this.toSkillConfig(entry));
  }

  async getProviderConfigs(): Promise<Record<string, ProviderConfigEntry>> {
    const config = await this.loadConfig();
    if (!config) return {};
    const result: Record<string, ProviderConfigEntry> = {};
    for (const skill of config.skills) {
      if (!skill.providers) continue;
      for (const provider of skill.providers) {
        result[skill.id] = provider;
      }
    }
    return result;
  }

  async getRuntimeSystemSkills(): Promise<RuntimeSystemSkill[]> {
    const config = await this.loadConfig();
    if (!config) return [];
    return config.skills.map((entry) => this.toRuntimeSystemSkill(entry));
  }

  private toSkillConfig(entry: SystemSkillEntry): SkillConfig {
    return {
      repo: `system/${entry.id}`,
      name: entry.name,
      description: entry.description,
      instructions: entry.instructions,
      enabled: true,
      system: true,
      mcpServers: entry.mcpServers,
      nixPackages: entry.nixPackages,
      permissions: entry.permissions,
    };
  }

  private toRuntimeSystemSkill(entry: SystemSkillEntry): RuntimeSystemSkill {
    const repo = `system/${entry.id}`;
    const lines: string[] = [
      `# ${entry.name}`,
      "",
      `System skill ID: \`${repo}\``,
    ];

    if (entry.instructions?.trim()) {
      lines.push("", `**Instructions:** ${entry.instructions.trim()}`);
    }

    if (entry.description?.trim()) {
      lines.push("", entry.description.trim());
    }

    if (entry.mcpServers?.length) {
      lines.push("", "## MCP Servers");
      for (const mcp of entry.mcpServers) {
        const endpoint = mcp.url || mcp.command || "n/a";
        lines.push(`- ${mcp.name || mcp.id} (\`${mcp.id}\`): ${endpoint}`);
      }
    }

    if (entry.permissions?.length) {
      lines.push(
        "",
        "## Network Permissions",
        `- ${entry.permissions.join(", ")}`
      );
    }

    if (entry.nixPackages?.length) {
      lines.push("", "## Nix Packages", `- ${entry.nixPackages.join(", ")}`);
    }

    lines.push(
      "",
      "## Usage",
      "- Use MCP tools for API access (auth handled by Owletto).",
      "- Skills with `permissions` require user-approved network grants.",
      "- Skills with `nixPackages` require user-approved package installs."
    );

    return {
      id: entry.id,
      repo,
      name: entry.name,
      description: entry.description,
      instructions: entry.instructions,
      content: lines.join("\n"),
    };
  }

  /**
   * Clear cached config and optionally set a new URL.
   * Next call to getSystemSkills() etc. will re-fetch.
   */
  reload(newUrl?: string): void {
    this.loaded = undefined;
    this.rawLoaded = undefined;
    if (newUrl !== undefined) {
      this.configUrl = newUrl;
    }
  }

  private async loadConfig(): Promise<SystemSkillsConfigFile | null> {
    if (this.loaded) return this.loaded;
    if (this.loadAttempted || !this.configUrl) return null;
    try {
      let raw: string;
      if (
        this.configUrl.startsWith("http://") ||
        this.configUrl.startsWith("https://")
      ) {
        const response = await fetch(this.configUrl);
        if (!response.ok) {
          logger.error(
            `Failed to fetch system skills config: ${response.status}`
          );
          return null;
        }
        raw = await response.text();
      } else {
        raw = await readFile(this.configUrl, "utf-8");
      }
      this.rawLoaded = JSON.parse(raw) as SystemSkillsConfigFile;
      const substituted = raw.replace(
        /\$\{env:([^}]+)\}/g,
        (_match, varName) => {
          if (ENV_SUBSTITUTION_BLOCKLIST.has(varName)) {
            logger.warn(
              `Blocked env substitution for sensitive var: ${varName}`
            );
            return "";
          }
          return process.env[varName] || "";
        }
      );
      const parsed = JSON.parse(substituted) as SystemSkillsConfigFile;
      if (!Array.isArray(parsed.skills)) {
        logger.error("Invalid system skills config: missing 'skills' array");
        return null;
      }
      this.loaded = parsed;
      logger.info(`Loaded ${parsed.skills.length} system skill(s)`);
      return parsed;
    } catch (error) {
      this.loadAttempted = true;
      logger.debug("System skills config not available", { error });
      return null;
    }
  }
}
