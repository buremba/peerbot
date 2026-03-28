import {
  type CommandContext,
  type CommandRegistry,
  createLogger,
} from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings";
import {
  buildClaimSettingsUrl,
  type ClaimService,
} from "../auth/settings/claim-service";
import {
  getModelSelectionState,
  resolveEffectiveModelRef,
} from "../auth/settings/model-selection";
import { getAuthMethod } from "../connections/platform-auth-methods";

const logger = createLogger("built-in-commands");

export interface BuiltInCommandDeps {
  agentSettingsStore: AgentSettingsStore;
  claimService: ClaimService;
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

      // DMs on webapp-initdata platforms: check if user has a linked OAuth identity
      const authMethod = getAuthMethod(ctx.platform);
      if (
        authMethod.type === "webapp-initdata" &&
        !ctx.channelId.startsWith("-")
      ) {
        const linkedOAuthUserId = await deps.claimService.getLinkedOAuthUserId(
          ctx.platform,
          ctx.userId
        );

        if (linkedOAuthUserId) {
          // Linked: use initData URL with web_app button (native mini app)
          const baseUrl =
            process.env.PUBLIC_GATEWAY_URL || "http://localhost:8080";
          const settingsUrl = new URL("/agent", baseUrl);
          settingsUrl.searchParams.set("platform", ctx.platform);
          settingsUrl.searchParams.set("chat", ctx.channelId);
          if (ctx.connectionId) {
            settingsUrl.searchParams.set("connectionId", ctx.connectionId);
          }
          await ctx.reply("Tap the button below to open agent settings.", {
            url: settingsUrl.toString(),
            urlLabel: "Open Agent Settings",
            webApp: true,
          });
          return;
        }

        // Not linked: claim URL with url button (opens in browser for OAuth)
        const claimCode = await deps.claimService.createClaim(
          ctx.platform,
          ctx.channelId,
          ctx.userId
        );
        const settingsUrl = buildClaimSettingsUrl(claimCode, {
          agentId: ctx.agentId,
        });
        await ctx.reply(
          "Tap the button below to sign in and configure your agent.",
          { url: settingsUrl, urlLabel: "Sign In" }
        );
        return;
      }

      const claimCode = await deps.claimService.createClaim(
        ctx.platform,
        ctx.channelId,
        ctx.userId
      );
      const settingsUrl = buildClaimSettingsUrl(claimCode, {
        agentId: ctx.agentId,
      });
      await ctx.reply(
        "Here's your settings link.\n\nUse this page to configure your agent's model, network access, and more.",
        { url: settingsUrl, urlLabel: "Open Settings" }
      );
    },
  });

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
