import type { CommandContext, CommandRegistry } from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings/index.js";
import {
  getModelSelectionState,
  resolveEffectiveModelRef,
} from "../auth/settings/model-selection.js";

interface BuiltInCommandDeps {
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
    name: "new",
    description: "Save context to memory and start a fresh session",
    handler: async (ctx: CommandContext) => {
      // Handled by message-handler-bridge before slash dispatch
      await ctx.reply("Starting new session...");
    },
  });

  registry.register({
    name: "clear",
    description: "Clear chat history and start fresh",
    handler: async (ctx: CommandContext) => {
      // Handled by message-handler-bridge before slash dispatch
      await ctx.reply("Chat history cleared.");
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

      const modelSelection = getModelSelectionState(settings);
      const effectiveModel = resolveEffectiveModelRef(settings);
      const model = effectiveModel || "auto";
      const mcpCount = settings?.mcpServers
        ? Object.keys(settings.mcpServers).length
        : 0;
      const skillsCount = settings?.skillsConfig?.skills
        ? Object.keys(settings.skillsConfig.skills).length
        : 0;

      const parts = [
        `Agent: ${ctx.agentId}`,
        `Model: ${model} (${modelSelection.mode})`,
        `MCP servers: ${mcpCount}`,
        `Skills: ${skillsCount}`,
      ];

      await ctx.reply(parts.join("\n"));
    },
  });
}
