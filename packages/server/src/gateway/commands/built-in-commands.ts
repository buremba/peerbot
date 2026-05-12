import type { CommandContext, CommandRegistry } from "@lobu/core";
import { consumeSlackPreviewClaim } from "../../preview/slack.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
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

  // Slack Preview: redeem a `/lobu link <code>` minted by `lobu run` and bind
  // this channel/DM to that agent. Re-running it with a different code rebinds.
  // (Slack only delivers the natively-registered `/lobu` slash command, so this
  // is reached as the `link` subcommand — not a bare `/link`.)
  registry.register({
    name: "link",
    description:
      "Link this chat to a Lobu agent using a code from `lobu run` (Slack Preview)",
    handler: async (ctx: CommandContext) => {
      const code = ctx.args.trim();
      if (!code) {
        await ctx.reply(
          "Usage: `/lobu link <code>` — get a code by running `lobu run` on a Slack-Preview-enabled agent."
        );
        return;
      }
      if (ctx.platform !== "slack" || !ctx.teamId) {
        await ctx.reply("`/lobu link` only works in Slack.");
        return;
      }
      const result = await consumeSlackPreviewClaim({
        code,
        teamId: ctx.teamId,
        channelId: ctx.channelId,
      });
      switch (result.status) {
        case "bound":
          await ctx.reply(
            `Linked this chat to agent \`${result.agentId}\`. Say hi — I'll reply here from now on.`
          );
          return;
        case "not_found":
          await ctx.reply(
            "That link code is invalid or expired. Run `lobu run` again to get a fresh one."
          );
          return;
        case "surface_not_allowed":
          await ctx.reply(
            `This code can't be used in a ${result.surfaceType === "dm" ? "DM" : "channel"}. Check the agent's \`preview.slack.surfaces\` setting.`
          );
          return;
      }
    },
  });
}
