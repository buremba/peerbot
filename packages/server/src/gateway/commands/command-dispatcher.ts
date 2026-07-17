import {
  type CommandContext,
  type CommandRegistry,
  createLogger,
} from "@lobu/core";
import type { BehaviorSubscriptionService } from "../channels/behavior-subscription-service.js";
import { platformAgentId } from "../spaces/space-resolver.js";

const logger = createLogger("command-dispatcher");

interface CommandDispatchInput {
  platform: string;
  userId: string;
  channelId: string;
  teamId?: string;
  isGroup: boolean;
  conversationId?: string;
  connectionId?: string;
  organizationId?: string;
  reply: CommandContext["reply"];
}

interface CommandDispatcherDeps {
  registry: CommandRegistry;
  behaviorSubscriptionService: BehaviorSubscriptionService;
}

export class CommandDispatcher {
  private registry: CommandRegistry;
  private behaviorSubscriptionService: BehaviorSubscriptionService;

  constructor(deps: CommandDispatcherDeps) {
    this.registry = deps.registry;
    this.behaviorSubscriptionService = deps.behaviorSubscriptionService;
  }

  async tryHandleSlashText(
    rawText: string,
		input: CommandDispatchInput,
  ): Promise<boolean> {
    const match = rawText.trim().match(/^\/(\w+)(?:\s+(.*))?$/);
    if (!match?.[1]) return false;
    let commandName = match[1];
    let commandArgs = match[2]?.trim() || "";
    // Slack registers a single `/lobu` wrapper, so its subcommands arrive as
    // `/lobu link <code>`. Slack only dispatches that as a native slash command
    // in channels — in an "Agents & AI Apps" DM it is delivered as plain
    // message text instead (no slash-command UI). Unwrap the wrapper here so
    // `/lobu link <code>` typed or pasted from `lobu run` in a DM dispatches the
    // `link` subcommand, matching the native slash-command path.
    if (commandName.toLowerCase() === "lobu" && commandArgs) {
      const sub = commandArgs.match(/^(\S+)(?:\s+(.*))?$/);
      if (sub?.[1]) {
        commandName = sub[1];
        commandArgs = sub[2]?.trim() || "";
      }
    }
    return this.tryHandle(commandName, commandArgs, input);
  }

  async tryHandle(
    commandName: string,
    commandArgs: string,
		input: CommandDispatchInput,
  ): Promise<boolean> {
    const agentId = await this.resolveAgentId(input);

    logger.info(
      {
        platform: input.platform,
        commandName,
        userId: input.userId,
        channelId: input.channelId,
        teamId: input.teamId,
        agentId,
      },
			"Dispatching command",
    );

    return this.registry.tryHandle(commandName, {
      userId: input.userId,
      channelId: input.channelId,
      teamId: input.teamId,
      isGroup: input.isGroup,
      conversationId: input.conversationId,
      connectionId: input.connectionId,
			organizationId: input.organizationId,
      agentId,
      args: commandArgs,
      platform: input.platform,
      reply: input.reply,
    });
  }

  private async resolveAgentId(input: CommandDispatchInput): Promise<string> {
    // Check message Behaviors first (Slack multi-tenant). Scope to the inbound
    // org so an org-less read cannot match another tenant's subscription.
		const subscription =
			input.connectionId && input.organizationId
				? await this.behaviorSubscriptionService.resolveForConnection(
						input.connectionId,
      input.channelId,
						input.organizationId,
					)
				: null;
    if (subscription?.agentId) {
      return subscription.agentId;
    }

    return platformAgentId(
      input.platform,
      input.userId,
      input.channelId,
			input.isGroup,
    );
  }
}
