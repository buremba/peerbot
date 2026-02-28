import { createLogger, DEFAULTS } from "@lobu/core";
import type { WebClient } from "@slack/web-api";
import type { AdminStatusCache } from "../../auth/admin-status-cache";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import type { AgentSettingsStore } from "../../auth/settings";
import {
  buildSettingsUrl,
  generateChannelSettingsToken,
} from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChannelBindingService } from "../../channels";
import type { CommandDispatcher } from "../../commands/command-dispatcher";
import { createSlackThreadReply } from "../../commands/command-reply-adapters";
import type {
  MessagePayload,
  QueueProducer,
} from "../../infrastructure/queue/queue-producer";
import type { TranscriptionService } from "../../services/transcription-service";
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
  private transcriptionService?: TranscriptionService;
  private userAgentsStore?: UserAgentsStore;
  private agentMetadataStore?: AgentMetadataStore;
  private adminStatusCache?: AdminStatusCache;
  private commandDispatcher?: CommandDispatcher;

  constructor(
    private queueProducer: QueueProducer,
    private config: MessageHandlerConfig,
    private sessionManager: ISessionManager,
    private slackClient: WebClient
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
   * Set the transcription service for voice/audio processing (optional)
   */
  setTranscriptionService(service: TranscriptionService): void {
    this.transcriptionService = service;
  }

  /**
   * Set user agents store for agent configuration flow
   */
  setUserAgentsStore(store: UserAgentsStore): void {
    this.userAgentsStore = store;
  }

  /**
   * Set agent metadata store for agent configuration flow
   */
  setAgentMetadataStore(store: AgentMetadataStore): void {
    this.agentMetadataStore = store;
  }

  /**
   * Set admin status cache for permission checks
   */
  setAdminStatusCache(cache: AdminStatusCache): void {
    this.adminStatusCache = cache;
  }

  setCommandDispatcher(dispatcher: CommandDispatcher): void {
    this.commandDispatcher = dispatcher;
  }

  /**
   * Transcribe audio files from Slack message.
   * Returns the original message with transcriptions prepended.
   */
  private async transcribeAudioFiles(
    userRequest: string,
    files: any[] | undefined,
    slackToken?: string
  ): Promise<string> {
    if (!files?.length || !this.transcriptionService) {
      return userRequest;
    }

    // Filter for audio files
    const audioFiles = files.filter((f) => {
      const mimetype = f.mimetype?.toLowerCase() || "";
      const filetype = f.filetype?.toLowerCase() || "";
      return (
        mimetype.startsWith("audio/") ||
        mimetype === "application/ogg" ||
        ["mp3", "m4a", "wav", "ogg", "opus", "webm", "aac"].includes(filetype)
      );
    });

    if (audioFiles.length === 0) {
      return userRequest;
    }

    logger.info(
      { audioFileCount: audioFiles.length },
      "Attempting to transcribe Slack audio files"
    );

    const transcriptions: string[] = [];

    for (const audioFile of audioFiles) {
      try {
        // Download the file from Slack
        const downloadUrl =
          audioFile.url_private_download || audioFile.url_private;
        if (!downloadUrl) {
          logger.warn(
            { fileId: audioFile.id },
            "No download URL for audio file"
          );
          continue;
        }

        const token =
          slackToken || this.config.slack.token || process.env.SLACK_BOT_TOKEN;
        const response = await fetch(downloadUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          logger.warn(
            { fileId: audioFile.id, status: response.status },
            "Failed to download Slack audio file"
          );
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const mimetype = audioFile.mimetype || "audio/mpeg";
        const filename =
          audioFile.name || `audio.${audioFile.filetype || "mp3"}`;

        const result = await this.transcriptionService.transcribe(
          buffer,
          filename,
          mimetype
        );

        if ("text" in result) {
          // Success case
          transcriptions.push(`[Voice message]: ${result.text}`);
          logger.info(
            { fileId: audioFile.id, textLength: result.text.length },
            "Audio transcription successful"
          );
        } else if (
          result.error?.includes("No transcription provider configured")
        ) {
          logger.info("Transcription service not configured - skipping audio");
          break; // No point trying more files
        } else {
          logger.warn(
            { fileId: audioFile.id, error: result.error },
            "Audio transcription failed"
          );
        }
      } catch (error) {
        logger.error(
          { fileId: audioFile.id, error: String(error) },
          "Error transcribing audio file"
        );
      }
    }

    if (transcriptions.length === 0) {
      return userRequest;
    }

    // Prepend transcriptions to the message
    const transcriptionPrefix = transcriptions.join("\n\n");
    if (!userRequest.trim() || userRequest === "[Audio message]") {
      return transcriptionPrefix;
    }
    return `${transcriptionPrefix}\n\n${userRequest}`;
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
      hasNixConfig: !!settings.nixConfig,
    });

    // Merge settings into options
    const mergedOptions: Record<string, any> = { ...baseOptions };

    if (settings.model) {
      mergedOptions.model = settings.model;
    } else if ((settings.installedProviders?.length ?? 0) > 0) {
      // Agent has providers installed but no explicit model - clear the
      // global default so auto-mode picks the primary installed provider.
      delete mergedOptions.model;
    }
    // Pass additional settings through agentOptions for worker to use
    if (settings.networkConfig) {
      mergedOptions.networkConfig = settings.networkConfig;
    }
    if (settings.nixConfig) {
      mergedOptions.nixConfig = settings.nixConfig;
    }

    if (settings.envVars) {
      mergedOptions.envVars = settings.envVars;
    }

    // MCP servers from agent settings
    if (settings.mcpServers) {
      mergedOptions.mcpServers = settings.mcpServers;
    }

    // Plugin configuration
    if (settings.pluginsConfig) {
      mergedOptions.pluginsConfig = settings.pluginsConfig;
    }

    // Verbose logging
    if (settings.verboseLogging !== undefined) {
      mergedOptions.verboseLogging = settings.verboseLogging;
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

    // Transcribe audio files if present
    const processedRequest = await this.transcribeAudioFiles(
      userRequest,
      files,
      client.token
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
      conversationId: normalizedThreadTs,
      messageId: context.messageTs,
    });

    // Check if this is a Direct Message channel (DMs start with 'D')
    const isDirectMessage = context.channelId.startsWith("D");

    // Handle slash commands via shared dispatcher before normal message routing
    if (this.commandDispatcher) {
      const handled = await this.commandDispatcher.tryHandleSlashText(
        userRequest,
        {
          platform: "slack",
          userId: context.userId,
          channelId: context.channelId,
          teamId: context.teamId,
          isGroup: !isDirectMessage,
          conversationId: normalizedThreadTs,
          reply: createSlackThreadReply(
            client,
            context.channelId,
            normalizedThreadTs
          ),
        }
      );

      if (handled) return;
    }

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
        // No binding - send configuration prompt
        const sent = await this.sendConfigurationPrompt(
          context,
          client,
          isDirectMessage
        );
        if (sent) return;

        // Fallback if config prompt fails (e.g., stores not wired)
        const space = resolveSpace({
          platform: "slack",
          userId: context.userId,
          channelId: context.channelId,
          isGroup: !isDirectMessage,
        });
        agentId = space.agentId;
        logger.info(
          `Fallback resolved agentId: ${agentId} (isGroup: ${!isDirectMessage})`
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
      const conversationId = normalizedThreadTs;

      // Create thread session with turn count
      const threadSession: ThreadSession = {
        conversationId,
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

        // Extract top-level configs from agentOptions for orchestration
        const { networkConfig, nixConfig, mcpServers, ...remainingOptions } =
          agentOptions;

        const deploymentPayload: MessagePayload = {
          userId: context.userId,
          botId: this.getBotId(),
          conversationId,
          teamId: context.teamId,
          agentId,
          platform: "slack",
          messageId: context.messageTs,
          messageText: processedRequest,
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
          agentOptions: remainingOptions,
          // Set top-level configs for orchestration
          networkConfig,
          nixConfig,
          mcpConfig: mcpServers ? { mcpServers } : undefined,
        };

        const jobId =
          await this.queueProducer.enqueueMessage(deploymentPayload);

        // Set status indicator
        await this.setThreadStatus(
          context.channelId,
          conversationId,
          "is scheduling.."
        );

        logger.info(
          `Enqueued direct message job ${jobId} for session ${sessionKey}`
        );
      } else {
        await this.sessionManager.setSession(threadSession);

        // Extract top-level configs from agentOptions for orchestration
        const { networkConfig, nixConfig, mcpServers, ...remainingOptions } =
          agentOptions;

        // Enqueue to user-specific queue
        const threadPayload: MessagePayload = {
          botId: this.getBotId(),
          userId: context.userId,
          conversationId,
          teamId: context.teamId,
          agentId,
          platform: "slack",
          channelId: context.channelId,
          messageId: context.messageTs,
          messageText: processedRequest,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            responseChannel: context.channelId,
            responseId: context.messageTs,
            originalMessageId: context.messageTs,
            botResponseId: threadSession.botResponseId,
            files: files || [],
          },
          agentOptions: remainingOptions,
          // Set top-level configs for orchestration
          networkConfig,
          nixConfig,
          mcpConfig: mcpServers ? { mcpServers } : undefined,
        };

        const jobId = await this.queueProducer.enqueueMessage(threadPayload);

        // Set status indicator
        await this.setThreadStatus(
          context.channelId,
          conversationId,
          "is scheduling.."
        );

        logger.info(
          `Enqueued thread message job ${jobId} for conversation ${conversationId}`
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
   * Send a configuration prompt to the user when no agent is bound to a channel.
   * Returns true if the prompt was sent (caller should stop processing).
   * Returns false if the prompt could not be sent (caller should fallback).
   */
  private async sendConfigurationPrompt(
    context: SlackContext,
    client: WebClient,
    isDirectMessage: boolean
  ): Promise<boolean> {
    // Need all stores to send a config prompt
    if (!this.userAgentsStore || !this.agentMetadataStore) {
      return false;
    }

    try {
      const token = generateChannelSettingsToken(
        context.userId,
        "slack",
        context.channelId,
        context.teamId
      );

      const configUrl = buildSettingsUrl(token);
      const threadTs = context.threadTs || context.messageTs;

      if (isDirectMessage) {
        // DM - reply directly in the conversation
        await client.chat.postMessage({
          channel: context.channelId,
          thread_ts: threadTs,
          text: `Welcome! To get started, please configure which agent should handle this conversation.`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Welcome! To get started, please configure which agent should handle this conversation.`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Configure Agent" },
                  url: configUrl,
                  style: "primary",
                  action_id: "configure_agent",
                },
              ],
            },
          ],
        });
      } else {
        // Group channel - check admin permissions
        const canConfigure = await this.checkCanConfigure(
          "slack",
          context.channelId,
          context.userId,
          context.teamId
        );

        if (!canConfigure.allowed) {
          await client.chat.postEphemeral({
            channel: context.channelId,
            user: context.userId,
            text:
              canConfigure.reason ||
              "Only admins can configure the bot for this channel.",
          });
          return true;
        }

        // Slack chat.postMessage needs a channel ID. Open (or find) a DM channel first.
        let dmChannelId: string | undefined;
        try {
          const opened = await client.conversations.open({
            users: context.userId,
            return_im: true,
          });
          dmChannelId = opened.channel?.id;
        } catch (error) {
          logger.warn("Failed to open DM channel for configuration link", {
            error,
            userId: context.userId,
          });
        }

        if (dmChannelId) {
          await client.chat.postMessage({
            channel: dmChannelId,
            text: `Please configure which agent should handle messages in <#${context.channelId}>`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Please configure which agent should handle messages in <#${context.channelId}>`,
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Configure Agent" },
                    url: configUrl,
                    style: "primary",
                    action_id: "configure_agent",
                  },
                ],
              },
            ],
          });
        } else {
          // If DM can't be opened (scopes, Slack restrictions), send ephemeral with a button.
          await client.chat.postEphemeral({
            channel: context.channelId,
            user: context.userId,
            text: `Configure which agent should handle messages in <#${context.channelId}>: ${configUrl}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Configure which agent should handle messages in <#${context.channelId}>`,
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Configure Agent" },
                    url: configUrl,
                    style: "primary",
                    action_id: "configure_agent",
                  },
                ],
              },
            ],
          });
          return true;
        }

        // Ephemeral reply in the channel
        await client.chat.postEphemeral({
          channel: context.channelId,
          user: context.userId,
          text: "I sent you a DM with a link to configure your agent for this channel.",
        });
      }

      logger.info(
        `Sent configuration prompt to user ${context.userId} for channel ${context.channelId}`
      );
      return true;
    } catch (error) {
      logger.error("Failed to send configuration prompt", { error });
      return false;
    }
  }

  /**
   * Check if a user can configure an agent for a channel.
   * DMs always allow. Groups check admin status with fallback to first-user.
   */
  private async checkCanConfigure(
    platform: string,
    channelId: string,
    userId: string,
    teamId?: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Always allow in DMs
    if (channelId.startsWith("D")) {
      return { allowed: true };
    }

    // Check if already configured by someone else
    if (this.channelBindingService) {
      const existing = await this.channelBindingService.getBinding(
        platform,
        channelId,
        teamId
      );
      if (existing?.configuredBy && existing.configuredBy !== userId) {
        // Already configured by someone else - check if current user is admin
        const isAdmin = await this.isSlackWorkspaceAdmin(userId);
        if (isAdmin !== true) {
          return {
            allowed: false,
            reason: `This channel is already configured by another user. Only workspace admins can reconfigure.`,
          };
        }
      }
    }

    // Try admin check
    const isAdmin = await this.isSlackWorkspaceAdmin(userId);

    if (isAdmin === true) {
      return { allowed: true };
    }

    if (isAdmin === false) {
      return {
        allowed: false,
        reason:
          "Only workspace admins can configure the bot for group channels.",
      };
    }

    // isAdmin === null (API error) - fallback to first-user
    if (this.channelBindingService) {
      const existing = await this.channelBindingService.getBinding(
        platform,
        channelId,
        teamId
      );
      if (!existing) {
        logger.info(
          `Admin check failed for ${userId}, using first-user fallback`
        );
        return { allowed: true };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a Slack user is a workspace admin.
   * Returns true/false for definitive answer, null if API check failed.
   */
  private async isSlackWorkspaceAdmin(userId: string): Promise<boolean | null> {
    // Check cache first
    if (this.adminStatusCache) {
      const cached = await this.adminStatusCache.getStatus(
        "slack",
        "workspace",
        userId
      );
      if (cached !== null) return cached;
    }

    try {
      const userInfo = await this.slackClient.users.info({ user: userId });
      const isAdmin =
        userInfo.user?.is_admin || userInfo.user?.is_owner || false;

      // Cache the result
      if (this.adminStatusCache) {
        await this.adminStatusCache.setStatus(
          "slack",
          "workspace",
          userId,
          isAdmin
        );
      }

      return isAdmin;
    } catch (error) {
      logger.warn(`Failed to check Slack admin status for ${userId}`, {
        error,
      });
      return null;
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
