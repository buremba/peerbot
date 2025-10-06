import { SessionUtils } from "@peerbot/shared";
import { createLogger } from "@peerbot/shared";
import type { DatabaseAdapter } from "@peerbot/shared";

const logger = createLogger("dispatcher");
import type {
  QueueProducer,
  ThreadMessagePayload,
  WorkerDeploymentPayload,
} from "../../queue/task-queue-producer";
import type {
  DispatcherConfig,
  SlackContext,
  ThreadSession,
} from "../../types";
// GitHubRepositoryManager imported dynamically when needed

export class MessageHandler {
  private activeSessions = new Map<string, ThreadSession>();
  private readonly SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours session TTL
  private lastCleanupTime = Date.now();

  constructor(
    private queueProducer: QueueProducer,
    private config: DispatcherConfig,
    private database: DatabaseAdapter
  ) {
    this.startCachePrewarming();
  }

  /**
   * Get bot ID from configuration
   */
  private getBotId(): string {
    return this.config.slack.botId || "default-slack-bot";
  }

  /**
   * Get user environment variables from database with channel and repository precedence
   * Priority: Channel+Repo > Channel > User+Repo > User
   */
  async getUserEnvironment(
    userId: string,
    channelId?: string,
    repository?: string
  ): Promise<Record<string, string | undefined>> {
    const envVariables = await this.database.getEnvironmentVariables({
      platformUserId: userId,
      channelId,
      repository,
    });

    if (Object.keys(envVariables).length > 0) {
      logger.info(
        `Found ${Object.keys(envVariables).length} environment variables for user ${userId}` +
          (channelId ? ` in channel ${channelId}` : "") +
          (repository ? ` for repository ${repository}` : "")
      );
    }

    if (envVariables.GITHUB_REPOSITORY) {
      logger.info(`Using repository: ${envVariables.GITHUB_REPOSITORY}`);
    }

    return envVariables;
  }

  /**
   * Handle user request by routing to appropriate queue
   */
  async handleUserRequest(
    context: SlackContext,
    userRequest: string,
    client: any
  ): Promise<void> {
    const requestStartTime = Date.now();
    logger.info(
      `[TIMING] handleUserRequest started at: ${new Date(requestStartTime).toISOString()}`
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
    const threadCreatorSessionKey = SessionUtils.generateSessionKey({
      platform: "slack",
      channelId: context.channelId,
      userId: context.userId,
      threadTs: normalizedThreadTs,
      messageTs: context.messageTs,
    });

    // Check for existing session to find thread creator
    let existingSession: ThreadSession | undefined;
    for (const [, session] of this.activeSessions.entries()) {
      if (
        session.threadTs === normalizedThreadTs &&
        session.channelId === context.channelId
      ) {
        existingSession = session;
        break;
      }
    }

    // Check if this is a reply from someone other than the thread creator
    if (
      existingSession?.threadCreator &&
      existingSession.threadCreator !== context.userId
    ) {
      logger.warn(
        `User ${context.userId} tried to interact with thread owned by ${existingSession.threadCreator}`
      );

      // Send ownership message
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: normalizedThreadTs,
        text: `This thread is owned by <@${existingSession.threadCreator}>. Only the thread creator can interact with the bot in this conversation.`,
        mrkdwn: true,
      });

      return;
    }

    const sessionKey = threadCreatorSessionKey;

    logger.info(
      `Handling request for session: ${sessionKey} (threadTs: ${normalizedThreadTs})`
    );

    logger.info(
      `Existing session status for ${sessionKey}: ${existingSession?.status || "none"}`
    );

    try {
      // Get repository from environment variables (stored via GitHub OAuth flow)
      const preliminaryEnv = await this.getUserEnvironment(
        context.userId,
        context.channelId,
        undefined
      );
      const overrideRepo = preliminaryEnv.GITHUB_REPOSITORY as
        | string
        | undefined;

      let repository;
      if (overrideRepo) {
        // User has configured a repository URL via environment variable
        const repoUrl = overrideRepo;
        const parts = repoUrl.split("/");
        const repoName = parts[parts.length - 1];

        repository = {
          repositoryUrl: repoUrl,
          repositoryName: repoName,
          cloneUrl: repoUrl.endsWith(".git") ? repoUrl : `${repoUrl}.git`,
          createdAt: Date.now(),
          lastUsed: Date.now(),
        };

        logger.info(`Using repository for user ${context.userId}: ${repoUrl}`);
      } else {
        logger.info(
          `No repository configured for user ${context.userId} in channel ${context.channelId}`
        );
        repository = null;
      }

      const threadTs = normalizedThreadTs;

      // Create thread session
      const threadSession: ThreadSession = {
        sessionKey,
        threadTs: threadTs,
        channelId: context.channelId,
        userId: context.userId,
        threadCreator: context.userId, // Store the thread creator
        repositoryUrl: repository?.repositoryUrl || "",
        lastActivity: Date.now(),
        status: "pending",
        createdAt: Date.now(),
      };

      this.activeSessions.set(sessionKey, threadSession);

      // Add immediate acknowledgment reaction
      const isDM = context.channelId?.startsWith("D");
      const isRootMessage = !context.threadTs;
      if (isDM || isRootMessage) {
        try {
          logger.info(
            `👀 REACTION CHANGE: Adding acknowledgment reaction 'eyes' to message ${context.messageTs} in channel ${context.channelId}`
          );
          await client.reactions.add({
            channel: context.channelId,
            timestamp: context.messageTs,
            name: "eyes",
          });
          logger.info(`Added eyes reaction to message ${context.messageTs}`);
        } catch (reactionError) {
          logger.warn("Failed to add eyes reaction:", reactionError);
        }
      }

      // Determine if this is a new conversation
      const isNewConversation = !context.threadTs || !existingSession;

      if (isNewConversation) {
        const deploymentPayload: WorkerDeploymentPayload = {
          userId: context.userId,
          botId: this.getBotId(),
          threadId: threadTs,
          platform: "slack",
          platformUserId: context.userId,
          messageId: context.messageTs,
          messageText: userRequest,
          channelId: context.channelId,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            repositoryUrl: repository?.repositoryUrl || null,
            slackResponseChannel: context.channelId,
            slackResponseTs: context.messageTs,
            originalMessageTs: context.messageTs,
            botResponseTs: threadSession.botResponseTs,
          },
          claudeOptions: {
            allowedTools: this.config.claude.allowedTools,
            model: this.config.claude.model,
            timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
          },
          routingMetadata: {
            targetThreadId: threadTs,
            userId: context.userId,
          },
        };

        const jobId =
          await this.queueProducer.enqueueMessage(deploymentPayload);

        logger.info(
          `Enqueued direct message job ${jobId} for session ${sessionKey}`
        );
        threadSession.status = "pending";
      } else {
        // Enqueue to user-specific queue
        const threadPayload: ThreadMessagePayload = {
          botId: this.getBotId(),
          userId: context.userId,
          threadId: threadTs,
          platform: "slack",
          channelId: context.channelId,
          messageId: context.messageTs,
          messageText: userRequest,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            repositoryUrl: repository?.repositoryUrl || null,
            slackResponseChannel: context.channelId,
            slackResponseTs: context.messageTs,
            originalMessageTs: context.messageTs,
            botResponseTs: threadSession.botResponseTs,
          },
          claudeOptions: {
            ...this.config.claude,
            timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
          },
          routingMetadata: {
            targetThreadId: threadTs,
            userId: context.userId,
          },
        };

        const jobId = await this.queueProducer.enqueueMessage(threadPayload);

        logger.info(
          `Enqueued thread message job ${jobId} for thread ${threadTs}`
        );
        threadSession.status = "running";
      }
    } catch (error) {
      logger.error(
        `Failed to handle request for session ${sessionKey}:`,
        error
      );

      // Handle all errors the same way - let the worker decide what to show
      try {
        await client.reactions.remove({
          channel: context.channelId,
          timestamp: context.messageTs,
          name: "eyes",
        });

        await client.reactions.add({
          channel: context.channelId,
          timestamp: context.messageTs,
          name: "x",
        });
      } catch (reactionError) {
        logger.error("Failed to update error reaction:", reactionError);
      }

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
      this.activeSessions.delete(sessionKey);
    }
  }

  /**
   * Extract Slack context from event
   */
  extractSlackContext(event: any): SlackContext {
    return {
      channelId: event.channel,
      userId: event.user,
      teamId: event.team || "",
      threadTs: event.thread_ts,
      messageTs: event.ts,
      text: event.text || "",
      userDisplayName: event.user_profile?.display_name || "Unknown User",
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
   */
  isUserAllowed(userId: string): boolean {
    const allowedUsers = process.env.ALLOWED_USERS || "";
    if (!allowedUsers) {
      return true; // If no restrictions, allow all
    }

    const userList = allowedUsers.split(",").map((u) => u.trim());
    return userList.includes(userId);
  }

  /**
   * Start cache prewarming
   */
  private startCachePrewarming(): void {
    setInterval(() => {
      this.cleanupExpiredData();
    }, 60000); // Every minute
  }

  /**
   * Cleanup expired data from caches
   */
  cleanupExpiredData(): void {
    const now = Date.now();

    // Only run cleanup every 5 minutes
    if (now - this.lastCleanupTime < 5 * 60 * 1000) {
      return;
    }

    this.lastCleanupTime = now;

    // Cleanup expired sessions
    for (const [key, session] of this.activeSessions.entries()) {
      if (now - session.lastActivity > this.SESSION_TTL) {
        logger.info(`Cleaning up expired session: ${key}`);
        this.activeSessions.delete(key);
      }
    }

    logger.info(
      `Cleanup completed - Active sessions: ${this.activeSessions.size}`
    );
  }

  // Getters for accessing private state
  getActiveSessions(): Map<string, ThreadSession> {
    return this.activeSessions;
  }

  setShortcutCommandHandler(_handler: any): void {
    // Reference to ShortcutCommandHandler - currently not used
  }
}
