import {
  type CommandContext,
  type CommandRegistry,
  createLogger,
} from "@lobu/core";
import type { ChannelBindingService } from "../channels/index.js";
import { platformAgentId } from "../spaces/index.js";

const logger = createLogger("command-dispatcher");

interface CommandDispatchInput {
  platform: string;
  userId: string;
  channelId: string;
  teamId?: string;
  isGroup: boolean;
  conversationId?: string;
  connectionId?: string;
  reply: CommandContext["reply"];
}

interface CommandDispatcherDeps {
  registry: CommandRegistry;
  channelBindingService: ChannelBindingService;
}

export class CommandDispatcher {
  private registry: CommandRegistry;
  private channelBindingService: ChannelBindingService;

  constructor(deps: CommandDispatcherDeps) {
    this.registry = deps.registry;
    this.channelBindingService = deps.channelBindingService;
  }

  async tryHandleSlashText(
    rawText: string,
    input: CommandDispatchInput
  ): Promise<boolean> {
    const match = rawText.trim().match(/^\/(\w+)(?:\s+(.*))?$/);
    if (!match?.[1]) return false;
    return this.tryHandle(match[1], match[2]?.trim() || "", input);
  }

  async tryHandle(
    commandName: string,
    commandArgs: string,
    input: CommandDispatchInput
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
      "Dispatching command"
    );

    return this.registry.tryHandle(commandName, {
      userId: input.userId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      connectionId: input.connectionId,
      agentId,
      args: commandArgs,
      platform: input.platform,
      reply: input.reply,
    });
  }

  private async resolveAgentId(input: CommandDispatchInput): Promise<string> {
    // Check channel binding first (Slack multi-tenant)
    const binding = await this.channelBindingService.getBinding(
      input.platform,
      input.channelId,
      input.teamId
    );
    if (binding?.agentId) {
      return binding.agentId;
    }

    return platformAgentId(
      input.platform,
      input.userId,
      input.channelId,
      input.isGroup
    );
  }
}
