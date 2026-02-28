import {
  type CommandContext,
  type CommandRegistry,
  createLogger,
} from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings";
import {
  buildSettingsUrl,
  formatSettingsTokenTtl,
  generateSettingsToken,
} from "../auth/settings";

const logger = createLogger("built-in-commands");

export interface BuiltInCommandDeps {
  agentSettingsStore: AgentSettingsStore;
}

/**
 * Register all built-in slash commands on the given registry.
 */
export function registerBuiltInCommands(
  registry: CommandRegistry,
  deps: BuiltInCommandDeps
): void {
  registry.register({
    name: "configure",
    description: "Open agent settings page",
    handler: async (ctx: CommandContext) => {
      logger.info(
        { userId: ctx.userId, agentId: ctx.agentId },
        "/configure command"
      );
      if (!ctx.agentId) {
        await ctx.reply("No agent is configured for this conversation yet.");
        return;
      }
      const token = generateSettingsToken(
        ctx.agentId,
        ctx.userId,
        ctx.platform,
        { channelId: ctx.channelId }
      );
      const settingsUrl = buildSettingsUrl(token);
      const ttlLabel = formatSettingsTokenTtl();
      await ctx.reply(
        `Here's your settings link (valid for ${ttlLabel}):\n${settingsUrl}\n\nUse this page to configure your agent's model, network access, and more.`
      );
    },
  });

  registry.register({
    name: "help",
    description: "Show available commands",
    handler: async (ctx: CommandContext) => {
      const commands = registry.getAll();
      const lines = commands.map((c) => `/${c.name} - ${c.description}`);
      await ctx.reply(
        `Available commands:\n${lines.join("\n")}\n\nYou can also just send a message to start a conversation with the agent.`
      );
    },
  });

  registry.register({
    name: "status",
    description: "Show current agent status",
    handler: async (ctx: CommandContext) => {
      if (!ctx.agentId) {
        await ctx.reply("No agent is configured for this conversation yet.");
        return;
      }

      const settings = await deps.agentSettingsStore.getSettings(ctx.agentId);

      const model = settings?.model || "default";
      const mcpCount = settings?.mcpServers
        ? Object.keys(settings.mcpServers).length
        : 0;
      const skillsCount = settings?.skillsConfig?.skills
        ? Object.keys(settings.skillsConfig.skills).length
        : 0;

      const parts = [
        `Agent: ${ctx.agentId}`,
        `Model: ${model}`,
        `MCP servers: ${mcpCount}`,
        `Skills: ${skillsCount}`,
      ];

      await ctx.reply(parts.join("\n"));
    },
  });
}
