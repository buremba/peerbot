import type { CommandContext, CommandRegistry } from "@lobu/core";
import {
  bindChatToAgentForOwner,
  bindChatToPreviewAgent,
  canonicalSlackChannelId,
  consumePreviewClaim,
  listPreviewAgents,
  previewAgentMenu,
  resolveChatUserIdentity,
} from "../../preview/slack.js";
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
      const skillsCount = settings?.skillsConfig?.skills
        ? Object.keys(settings.skillsConfig.skills).length
        : 0;

      const parts = [
        `Agent: ${ctx.agentId}`,
        `Model: ${model} (${modelSelection.mode})`,
        `Skills: ${skillsCount}`,
      ];

      await ctx.reply(parts.join("\n"));
    },
  });

  // Public preview: bind this chat to one of the demo agents in the preview
  // connection's org. `/lobu try <agentId>` (no code, no CLI); `/lobu try` /
  // `/lobu agents` with no arg lists them. Re-running with another agent
  // rebinds. (Reached as the `try` / `agents` subcommand on Slack.)
  const replyDemoMenu = async (ctx: CommandContext, prefix?: string) => {
    if (!ctx.connectionId) {
      await ctx.reply("Couldn't identify this workspace — try again in a moment.");
      return;
    }
    const agents = await listPreviewAgents(ctx.connectionId);
    const menu = previewAgentMenu(ctx.platform, agents);
    await ctx.reply(prefix ? `${prefix}\n\n${menu}` : menu);
  };

  registry.register({
    name: "try",
    description:
      "Try a demo agent in this workspace — `try <agentId>` (no arg lists them)",
    handler: async (ctx: CommandContext) => {
      const agentId = ctx.args.trim();
      if (!agentId) {
        await replyDemoMenu(ctx);
        return;
      }
      if (!ctx.connectionId) {
        await ctx.reply("Couldn't identify this workspace — try again in a moment.");
        return;
      }
      // Bindings are keyed on the canonical channel-id form; Slack slash
      // commands hand us the bare id.
      const channelId =
        ctx.platform === "slack"
          ? canonicalSlackChannelId(ctx.channelId)
          : ctx.channelId;
      const result = await bindChatToPreviewAgent({
        connectionId: ctx.connectionId,
        agentId,
        platform: ctx.platform,
        teamId: ctx.teamId,
        channelId,
      });
      switch (result.status) {
        case "bound":
          await ctx.reply(
            `Now talking to \`${result.agentId}\`. Say hi — I'll reply here from now on.`
          );
          return;
        case "not_available":
          await replyDemoMenu(ctx, `No demo agent \`${agentId}\` here.`);
          return;
        case "no_connection":
          await ctx.reply(
            "This chat isn't connected to a Lobu preview workspace."
          );
          return;
      }
    },
  });

  registry.register({
    name: "agents",
    description: "List the demo agents you can try here",
    handler: async (ctx: CommandContext) => {
      await replyDemoMenu(ctx);
    },
  });

  // Slack Preview: redeem a `/lobu link <code>` minted by `lobu run` and bind
  // this channel/DM to that agent. Re-running it with a different code rebinds.
  // (Slack only delivers the natively-registered `/lobu` slash command, so this
  // is reached as the `link` subcommand — not a bare `/link`.)
  registry.register({
    name: "link",
    description:
      "Link this chat to a Lobu agent — `<code>` from `lobu run`, or `<agentId>` once you've linked here before",
    handler: async (ctx: CommandContext) => {
      const arg = ctx.args.trim();
      const cmd = ctx.platform === "slack" ? "/lobu link" : "/link";
      if (!arg) {
        await ctx.reply(
          `Usage: \`${cmd} <code>\` — get a code by running \`lobu run\` on a Preview-enabled agent. (Once you've linked here once, \`${cmd} <agentId>\` works too.)`
        );
        return;
      }
      const surfaceType: "dm" | "channel" = ctx.isGroup ? "channel" : "dm";
      // The message handler looks bindings up by the platform's canonical
      // channel-id form; Slack slash commands hand us the bare id.
      const channelId =
        ctx.platform === "slack"
          ? canonicalSlackChannelId(ctx.channelId)
          : ctx.channelId;
      const result = await consumePreviewClaim({
        code: arg,
        platform: ctx.platform,
        teamId: ctx.teamId,
        channelId,
        surfaceType,
        platformUserId: ctx.userId,
      });
      switch (result.status) {
        case "bound":
          await ctx.reply(
            `Linked this chat to agent \`${result.agentId}\`. Say hi — I'll reply here from now on.`
          );
          return;
        case "surface_not_allowed":
          await ctx.reply(
            `This code can't be used in a ${result.surfaceType === "dm" ? "DM" : "channel"}. Check the agent's \`preview.${ctx.platform}.surfaces\` setting.`
          );
          return;
        case "not_found": {
          // Not a valid code — but if this user has linked here before, treat
          // the arg as an agent id and re-bind directly (no fresh code needed).
          const lobuUserId = await resolveChatUserIdentity(
            ctx.platform,
            ctx.teamId,
            ctx.userId
          );
          if (lobuUserId) {
            const bound = await bindChatToAgentForOwner({
              platform: ctx.platform,
              teamId: ctx.teamId,
              channelId,
              agentId: arg,
              lobuUserId,
            });
            if (bound.status === "bound") {
              await ctx.reply(
                `Linked this chat to agent \`${arg}\`. Say hi — I'll reply here from now on.`
              );
              return;
            }
            await ctx.reply(
              `No agent \`${arg}\` you can manage in your orgs. Either run \`lobu apply\` to register it, or paste a fresh \`/lobu link <code>\` from \`lobu run\`.`
            );
            return;
          }
          await ctx.reply(
            "That link code is invalid or expired. Run `lobu run` again to get a fresh one."
          );
          return;
        }
      }
    },
  });
}
