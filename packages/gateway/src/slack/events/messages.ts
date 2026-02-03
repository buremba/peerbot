import { createLogger, DEFAULTS } from "@peerbot/core";
import type { WebClient } from "@slack/web-api";
import {
  type AgentSettingsStore,
  buildSettingsUrl,
  generateSettingsToken,
} from "../../auth/settings";
import type { ChannelBindingService } from "../../channels";
import type {
  MessagePayload,
  QueueProducer,
} from "../../infrastructure/queue/queue-producer";
import type { InteractionService } from "../../interactions";
import type { ISessionManager, ThreadSession } from "../../session";
import { generateSessionKey } from "../../session";
import { resolveSpace } from "../../spaces";
import type { MessageHandlerConfig } from "../config";
import type { SlackContext, SlackMessageEvent } from "../types";

const logger = createLogger("dispatcher");

export class MessageHandler {
  private readonly SESSION_TTL = DEFAULTS.SESSION_TTL_MS;
  private channelBindingService?: ChannelBindingService;
  private agentSettingsStore?: AgentSettingsStore;

  constructor(
    private queueProducer: QueueProducer,
    private config: MessageHandlerConfig,
    private sessionManager: ISessionManager,
    private slackClient: WebClient,
    private interactionService: InteractionService
  ) {}

  /**
   * Set the channel binding service (optional)
   */
  setChannelBindingService(service: ChannelBindingService): void {
    this.channelBindingService = service;
  }

  /**
   * Set the agent settings store (optional)
   */
  setAgentSettingsStore(store: AgentSettingsStore): void {
    this.agentSettingsStore = store;
  }

  /**
   * Get agent options with settings applied
   * Priority: agent settings > config defaults
   */
  private async getAgentOptionsWithSettings(
    agentId: string
  ): Promise<Record<string, any>> {
    const baseOptions = {
      ...this.config.agentOptions,
      timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
    };

    if (!this.agentSettingsStore) {
      return baseOptions;
    }

    const settings = await this.agentSettingsStore.getSettings(agentId);
    if (!settings) {
      return baseOptions;
    }

    logger.info(`Applying agent settings for ${agentId}`, {
      model: settings.model,
      hasNetworkConfig: !!settings.networkConfig,
      hasGitConfig: !!settings.gitConfig,
    });

    // Merge settings into options
    const mergedOptions: Record<string, any> = { ...baseOptions };

    if (settings.model) {
      mergedOptions.model = settings.model;
    }

    // Pass additional settings through agentOptions for worker to use
    if (settings.networkConfig) {
      mergedOptions.networkConfig = settings.networkConfig;
    }

    if (settings.gitConfig) {
      mergedOptions.gitConfig = settings.gitConfig;
    }

    if (settings.envVars) {
      mergedOptions.envVars = settings.envVars;
    }

    if (settings.historyConfig) {
      mergedOptions.historyConfig = settings.historyConfig;
    }

    return mergedOptions;
  }

  /**
   * Get bot ID from configuration
   */
  private getBotId(): string {
    return this.config.slack.botId || "default-slack-bot";
  }

  /**
   * Set thread status indicator
   */
  private async setThreadStatus(
    channelId: string,
    threadTs: string,
    status: string
  ): Promise<void> {
    try {
      logger.info(
        `Setting thread status "${status}" for channel ${channelId}, thread ${threadTs}`
      );
      await this.slackClient.apiCall("assistant.threads.setStatus", {
        channel_id: channelId,
        thread_ts: threadTs,
        status,
        loading_messages: [
          "warming up...",
          "getting ready...",
          "thinking about it...",
          "on it...",
          "loading...",
          "waking up...",
          "brewing some thoughts...",
          "putting on thinking cap...",
        ],
      });
      logger.info(`Successfully set thread status "${status}"`);
    } catch (error) {
      // Non-critical - just log
      logger.warn(`Failed to set thread status: ${error}`);
    }
  }

  /**
   * Handle user request by routing to appropriate queue
   */
  async handleUserRequest(
    context: SlackContext,
    userRequest: string,
    client: WebClient,
    files?: any[]
  ): Promise<void> {
    const requestStartTime = Date.now();
    logger.info(
      `[TIMING] handleUserRequest started at: ${new Date(requestStartTime).toISOString()}`
    );
    logger.info(
      `📨 Handling request from user ${context.userId} in thread ${context.threadTs || context.messageTs}`
    );

    // CRITICAL: Always use thread_ts for thread identification
    // For root messages: thread_ts is undefined, so we use message_ts
    // For replies in thread: thread_ts points to the root message
    // This ensures all messages in a thread share the same worker
    const normalizedThreadTs = context.threadTs || context.messageTs;

    // Log for debugging thread routing
    logger.info(
      `Thread routing - messageTs: ${context.messageTs}, threadTs: ${context.threadTs}, normalizedThreadTs: ${normalizedThreadTs}`
    );

    // Generate session key with normalized threadTs - use thread creator as userId for consistency
    const threadCreatorSessionKey = generateSessionKey({
      platform: "slack",
      channelId: context.channelId,
      userId: context.userId,
      threadId: normalizedThreadTs,
      messageId: context.messageTs,
    });

    // Check if this is a Direct Message channel (DMs start with 'D')
    const isDirectMessage = context.channelId.startsWith("D");

    // Check for channel binding first (explicit agent assignment)
    let agentId: string;
    if (this.channelBindingService) {
      const binding = await this.channelBindingService.getBinding(
        "slack",
        context.channelId,
        context.teamId
      );
      if (binding) {
        agentId = binding.agentId;
        logger.info(
          `Using bound agentId: ${agentId} for channel ${context.channelId}`
        );
      } else {
        // Fall back to space-based resolution
        const space = resolveSpace({
          platform: "slack",
          userId: context.userId,
          channelId: context.channelId,
          isGroup: !isDirectMessage,
        });
        agentId = space.agentId;
        logger.info(
          `Resolved agentId: ${agentId} (isGroup: ${!isDirectMessage})`
        );
      }
    } else {
      // Fall back to space-based resolution
      const space = resolveSpace({
        platform: "slack",
        userId: context.userId,
        channelId: context.channelId,
        isGroup: !isDirectMessage,
      });
      agentId = space.agentId;
      logger.info(
        `Resolved agentId: ${agentId} (isGroup: ${!isDirectMessage})`
      );
    }

    // Handle /configure command - send settings magic link
    if (userRequest.trim().toLowerCase() === "/configure") {
      logger.info(
        `User ${context.userId} requested /configure for agent ${agentId}`
      );
      try {
        const token = generateSettingsToken(agentId, context.userId, "slack");
        const settingsUrl = buildSettingsUrl(token);

        await client.chat.postMessage({
          channel: context.channelId,
          thread_ts: normalizedThreadTs,
          text: `Here's your settings link (valid for 1 hour):\n${settingsUrl}\n\nUse this page to configure your agent's model, network access, git repository, and more.`,
        });
        logger.info(`Sent settings link to user ${context.userId}`);
      } catch (error) {
        logger.error("Failed to generate settings link", { error });
        await client.chat.postMessage({
          channel: context.channelId,
          thread_ts: normalizedThreadTs,
          text: "Sorry, I couldn't generate a settings link. Please try again later.",
        });
      }
      return;
    }

    // Only check thread ownership for non-DM channels
    if (!isDirectMessage) {
      const ownershipCheck = await this.sessionManager.validateThreadOwnership(
        context.channelId,
        normalizedThreadTs,
        context.userId
      );

      if (!ownershipCheck.allowed && ownershipCheck.owner) {
        logger.warn(
          `User ${context.userId} tried to interact with thread owned by ${ownershipCheck.owner}`
        );

        // Send ownership message
        await client.chat.postMessage({
          channel: context.channelId,
          thread_ts: normalizedThreadTs,
          text: `This thread is owned by <@${ownershipCheck.owner}>. Only the thread creator can interact with the bot in this conversation.`,
          mrkdwn: true,
        });

        return;
      }
    } else {
      logger.info(
        `Skipping thread ownership check for DM channel ${context.channelId}`
      );
    }

    // Get existing session if any
    const existingSession = await this.sessionManager.findSessionByThread(
      context.channelId,
      normalizedThreadTs
    );

    const sessionKey = threadCreatorSessionKey;

    logger.info(
      `Handling request for session: ${sessionKey} (threadTs: ${normalizedThreadTs})`
    );

    // Check turn count to prevent infinite loops
    const maxTurns = process.env.MAX_TURNS
      ? parseInt(process.env.MAX_TURNS, 10)
      : 50;
    const currentTurnCount = (existingSession?.turnCount || 0) + 1;

    if (currentTurnCount > maxTurns) {
      logger.warn(
        `Thread ${normalizedThreadTs} exceeded MAX_TURNS (${maxTurns}). Preventing infinite loop.`
      );
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: normalizedThreadTs,
        text: `⚠️ This conversation has exceeded the maximum turn limit (${maxTurns} turns). Please start a new thread to continue.`,
      });
      return;
    }

    logger.info(`Turn count: ${currentTurnCount}/${maxTurns}`);

    try {
      const threadTs = normalizedThreadTs;

      // Cancel any pending interactions for this thread when a new message arrives
      // This prevents the worker from being stuck waiting for interaction responses
      const pendingInteractionIds =
        await this.interactionService.getPendingInteractions(threadTs);
      if (pendingInteractionIds.length > 0) {
        logger.info(
          `Cancelling ${pendingInteractionIds.length} pending interaction(s) for thread ${threadTs} due to new user message`
        );

        for (const interactionId of pendingInteractionIds) {
          try {
            // Auto-respond with a cancellation message
            await this.interactionService.respond(
              interactionId,
              { answer: "[Cancelled - user sent a new message]" },
              context.userId
            );
            logger.info(`Cancelled pending interaction ${interactionId}`);
          } catch (err) {
            logger.error(`Failed to cancel interaction ${interactionId}:`, err);
          }
        }
      }

      // Create thread session with turn count
      const threadSession: ThreadSession = {
        threadId: threadTs,
        channelId: context.channelId,
        userId: context.userId,
        threadCreator: context.userId, // Store the thread creator
        lastActivity: Date.now(),
        createdAt: Date.now(),
        turnCount: currentTurnCount,
      };

      await this.sessionManager.setSession(threadSession);

      // Determine if this is a new conversation
      // A conversation is new only if this message is the ROOT of the thread (messageTs === threadTs)
      // OR if there's no thread_ts at all (first message in a channel/DM)
      const isNewConversation =
        context.messageTs === normalizedThreadTs && !existingSession;

      // Fetch agent settings and merge with config defaults
      const agentOptions = await this.getAgentOptionsWithSettings(agentId);

      if (isNewConversation) {
        await this.sessionManager.setSession(threadSession);

        const deploymentPayload: MessagePayload = {
          userId: context.userId,
          botId: this.getBotId(),
          threadId: threadTs,
          teamId: context.teamId,
          agentId,
          platform: "slack",
          messageId: context.messageTs,
          messageText: userRequest,
          channelId: context.channelId,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            responseChannel: context.channelId,
            responseId: context.messageTs,
            originalMessageId: context.messageTs,
            botResponseId: threadSession.botResponseId,
            files: files || [],
          },
          agentOptions,
        };

        const jobId =
          await this.queueProducer.enqueueMessage(deploymentPayload);

        // Set status indicator
        await this.setThreadStatus(
          context.channelId,
          threadTs,
          "is scheduling.."
        );

        logger.info(
          `Enqueued direct message job ${jobId} for session ${sessionKey}`
        );
      } else {
        await this.sessionManager.setSession(threadSession);

        // Enqueue to user-specific queue
        const threadPayload: MessagePayload = {
          botId: this.getBotId(),
          userId: context.userId,
          threadId: threadTs,
          teamId: context.teamId,
          agentId,
          platform: "slack",
          channelId: context.channelId,
          messageId: context.messageTs,
          messageText: userRequest,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            responseChannel: context.channelId,
            responseId: context.messageTs,
            originalMessageId: context.messageTs,
            botResponseId: threadSession.botResponseId,
            files: files || [],
          },
          agentOptions,
        };

        const jobId = await this.queueProducer.enqueueMessage(threadPayload);

        // Set status indicator
        await this.setThreadStatus(
          context.channelId,
          threadTs,
          "is scheduling.."
        );

        logger.info(
          `Enqueued thread message job ${jobId} for thread ${threadTs}`
        );
      }
    } catch (error) {
      logger.error(
        `Failed to handle request for session ${sessionKey}:`,
        error
      );

      // Handle all errors the same way - let the worker decide what to show
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorMsg = `❌ *Error:* ${errorMessage || "Unknown error occurred"}`;

      // Post error message in thread
      const threadTs = context.threadTs || context.messageTs;
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: threadTs,
        text: errorMsg,
        mrkdwn: true,
      });

      // Clean up session
      await this.sessionManager.deleteSession(sessionKey);
    }
  }

  /**
   * Extract Slack context from event
   */
  extractSlackContext(
    event: SlackMessageEvent,
    bodyTeamId?: string
  ): SlackContext {
    // Extract teamId from event.team (optional) or body.team_id (always present)
    const teamId = event.team || bodyTeamId || "";

    return {
      channelId: event.channel,
      userId: event.user || "",
      teamId: teamId,
      threadTs: event.thread_ts,
      messageTs: event.ts,
      text: event.text || "",
      userDisplayName:
        (event as { user_profile?: { display_name?: string } }).user_profile
          ?.display_name || "Unknown User",
    };
  }

  /**
   * Extract user request from mention text
   */
  extractUserRequest(text: string): string {
    const cleaned = text.replace(/<@[^>]+>/g, "").trim();

    if (!cleaned) {
      return "Hello! How can I help you today?";
    }

    return cleaned;
  }

  /**
   * Check if user is allowed to use the bot
   * Note: User allowlisting removed - all users are allowed by default
   */
  isUserAllowed(_userId: string): boolean {
    return true; // All users allowed
  }

  /**
   * Cleanup expired data from session store
   */
  async cleanupExpiredData(): Promise<void> {
    const deletedCount = await this.sessionManager.cleanupExpired(
      this.SESSION_TTL
    );
    if (deletedCount > 0) {
      logger.info(`Cleanup completed - Deleted ${deletedCount} sessions`);
    }
  }
}
