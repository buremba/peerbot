/**
 * Slack response renderer.
 * Handles streaming responses, rich formatting with BlockKit,
 * and Slack-specific status indicators.
 */

import type { IModuleRegistry } from "@lobu/core";
import { AsyncLock, createLogger, DEFAULTS, REDIS_KEYS } from "@lobu/core";
import type { AnyBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import type Redis from "ioredis";
import type {
  IMessageQueue,
  ThreadResponsePayload,
} from "../infrastructure/queue";
import type { ResponseRenderer } from "../platform/response-renderer";
import {
  type ModuleButton,
  SlackBlockBuilder,
} from "./converters/block-builder";
import { extractCodeBlockActions } from "./converters/blockkit";
import { convertMarkdownToSlack } from "./converters/markdown";
import type { SlackInstallationStore } from "./installation-store";

const logger = createLogger("slack-response-renderer");

/**
 * Represents a single Slack chatStream session.
 */
class StreamSession {
  private streamTs: string | null = null;
  private messageTs: string | null = null;
  private started = false;
  private streamLock: AsyncLock;
  readonly threadTs: string;

  constructor(
    private slackClient: WebClient,
    private channelId: string,
    threadTs: string,
    private userId: string,
    private teamId?: string
  ) {
    this.threadTs = threadTs;
    this.streamLock = new AsyncLock(`slack-stream-${channelId}-${threadTs}`);
  }

  private async withStreamLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.streamLock.acquire(fn);
  }

  private async setRunningStatus(): Promise<void> {
    try {
      await this.slackClient.apiCall("assistant.threads.setStatus", {
        channel_id: this.channelId,
        thread_ts: this.threadTs,
        status: "is running..",
        loading_messages: [
          "working on it...",
          "thinking...",
          "processing...",
          "cooking something up...",
          "crafting a response...",
          "figuring it out...",
          "on the case...",
          "analyzing...",
          "computing...",
        ],
      });
    } catch (error) {
      logger.warn(`Failed to set running status: ${error}`);
    }
  }

  private async clearStatus(): Promise<void> {
    try {
      await this.slackClient.apiCall("assistant.threads.setStatus", {
        channel_id: this.channelId,
        thread_ts: this.threadTs,
        status: "",
      });
    } catch (error) {
      logger.warn(`Failed to clear status: ${error}`);
    }
  }

  async appendDelta(
    delta: string,
    isFullReplacement = false
  ): Promise<string | null> {
    return this.withStreamLock(async () => {
      return this.appendDeltaUnsafe(delta, isFullReplacement);
    });
  }

  private async appendDeltaUnsafe(
    delta: string,
    isFullReplacement = false
  ): Promise<string | null> {
    if (isFullReplacement && this.started && this.streamTs) {
      logger.info(
        `Replacing stream content: channel=${this.channelId}, thread=${this.threadTs}`
      );
      await this.stop();
      this.started = false;
      this.streamTs = null;
    }

    if (!this.started) {
      logger.info(
        `Starting new stream: channel=${this.channelId}, thread=${this.threadTs}`
      );
      const response = (await this.slackClient.apiCall("chat.startStream", {
        channel: this.channelId,
        thread_ts: this.threadTs,
        markdown_text: convertMarkdownToSlack(delta),
        recipient_user_id: this.userId,
        ...(this.teamId ? { recipient_team_id: this.teamId } : {}),
      })) as {
        ok?: boolean;
        stream_ts?: string;
        ts?: string;
        error?: string;
      };

      if (!response.ok) {
        const error = response.error || "unknown_error";
        logger.error(`Failed to start Slack stream: ${error}`);
        throw new Error(`chat.startStream failed: ${error}`);
      }

      const streamTs = response.stream_ts || response.ts;
      const messageTs = response.ts || response.stream_ts;

      if (!streamTs) {
        throw new Error("chat.startStream response missing stream_ts");
      }

      this.streamTs = streamTs;
      this.messageTs = messageTs ?? streamTs;
      this.started = true;

      await this.setRunningStatus();
      return this.messageTs ?? this.streamTs;
    }

    // Append to existing stream
    if (this.streamTs && this.messageTs) {
      try {
        const response = (await this.slackClient.apiCall("chat.appendStream", {
          channel: this.channelId,
          stream_ts: this.streamTs,
          ts: this.messageTs,
          markdown_text: convertMarkdownToSlack(delta),
        })) as { ok?: boolean; error?: string };

        if (!response.ok) {
          const error = response.error || "unknown_error";
          if (error === "message_not_in_streaming_state") {
            logger.warn(`Streaming state lost, restarting stream`);
            this.streamTs = null;
            this.started = false;
            return this.appendDeltaUnsafe(delta, false);
          }
          throw new Error(`chat.appendStream failed: ${error}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("message_not_in_streaming_state")) {
          this.streamTs = null;
          this.started = false;
          return this.appendDeltaUnsafe(delta, false);
        }
        throw error;
      }
    }

    return this.messageTs ?? this.streamTs;
  }

  async stop(deleteMessage = false): Promise<void> {
    if (this.started && this.streamTs) {
      if (!this.messageTs) {
        throw new Error("Cannot stop stream without message timestamp");
      }

      const response = (await this.slackClient.apiCall("chat.stopStream", {
        channel: this.channelId,
        stream_ts: this.streamTs,
        ts: this.messageTs,
      })) as { ok?: boolean; error?: string };

      if (!response.ok) {
        const error = response.error || "unknown_error";
        logger.error(`Failed to stop Slack stream: ${error}`);
        throw new Error(`chat.stopStream failed: ${error}`);
      }

      if (deleteMessage && this.messageTs) {
        try {
          await this.slackClient.chat.delete({
            channel: this.channelId,
            ts: this.messageTs,
          });
        } catch (error) {
          logger.warn(`Failed to delete streaming message: ${error}`);
        }
      }

      this.streamTs = null;
      this.messageTs = null;
      this.started = false;
      await this.clearStatus();
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  getMessageTs(): string | null {
    return this.messageTs ?? this.streamTs;
  }
}

/**
 * Manages all active stream sessions.
 */
class StreamSessionManager {
  private sessions = new Map<string, StreamSession>();

  constructor(
    private slackClient: WebClient,
    private clientResolver?: (teamId?: string) => Promise<WebClient>
  ) {}

  async handleDelta(
    sessionId: string,
    channelId: string,
    threadTs: string,
    userId: string,
    delta: string,
    isFullReplacement = false,
    teamId?: string
  ): Promise<string | null> {
    let session = this.sessions.get(sessionId);

    if (!session) {
      // Resolve the client for this team
      const client = this.clientResolver
        ? await this.clientResolver(teamId)
        : this.slackClient;
      session = new StreamSession(client, channelId, threadTs, userId, teamId);
      this.sessions.set(sessionId, session);
    }

    const streamTs = await session.appendDelta(delta, isFullReplacement);
    return streamTs ?? session.getMessageTs();
  }

  async completeSession(
    sessionId: string,
    deleteMessage = false
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.stop(deleteMessage);
      this.sessions.delete(sessionId);
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async completeAllSessionsForThread(
    threadTs: string,
    deleteMessage = false
  ): Promise<number> {
    let stoppedCount = 0;
    const sessionsToStop: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.threadTs === threadTs) {
        sessionsToStop.push(sessionId);
      }
    }

    for (const sessionId of sessionsToStop) {
      await this.completeSession(sessionId, deleteMessage);
      stoppedCount++;
    }

    return stoppedCount;
  }
}

/**
 * Slack response renderer implementation.
 */
export class SlackResponseRenderer implements ResponseRenderer {
  private redis: Redis;
  private blockBuilder: SlackBlockBuilder;
  private streamSessionManager: StreamSessionManager;
  private readonly BOT_MESSAGES_PREFIX = REDIS_KEYS.BOT_MESSAGES;
  private installationStore?: SlackInstallationStore;
  private teamClients = new Map<string, WebClient>();
  private teamClientTimestamps = new Map<string, number>();

  constructor(
    queue: IMessageQueue,
    private slackClient: WebClient,
    private moduleRegistry: IModuleRegistry,
    installationStore?: SlackInstallationStore
  ) {
    this.redis = queue.getRedisClient();
    this.blockBuilder = new SlackBlockBuilder();
    this.installationStore = installationStore;
    this.streamSessionManager = new StreamSessionManager(
      slackClient,
      (teamId) => this.getClientForTeam(teamId)
    );
  }

  private static readonly CLIENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  /**
   * Get a WebClient for a specific team, caching instances with TTL.
   * Falls back to the default client when no team-specific token is found.
   */
  private async getClientForTeam(teamId?: string): Promise<WebClient> {
    if (!teamId || !this.installationStore) {
      return this.slackClient;
    }

    const cached = this.teamClients.get(teamId);
    const cachedAt = this.teamClientTimestamps.get(teamId);
    if (
      cached &&
      cachedAt &&
      Date.now() - cachedAt < SlackResponseRenderer.CLIENT_CACHE_TTL_MS
    ) {
      return cached;
    }

    const token = await this.installationStore.getTokenForTeam(teamId);
    if (!token) return this.slackClient;

    const client = new WebClient(token);
    this.teamClients.set(teamId, client);
    this.teamClientTimestamps.set(teamId, Date.now());
    return client;
  }

  private async getBotMessageTs(sessionKey: string): Promise<string | null> {
    const key = `${this.BOT_MESSAGES_PREFIX}${sessionKey}`;
    return await this.redis.get(key);
  }

  private async setBotMessageTs(
    sessionKey: string,
    botMessageTs: string
  ): Promise<void> {
    const key = `${this.BOT_MESSAGES_PREFIX}${sessionKey}`;
    await this.redis.set(key, botMessageTs, "EX", DEFAULTS.SESSION_TTL_SECONDS);
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<string | null> {
    if (!payload.delta) {
      return null;
    }

    // Suppress deltas when thread has an active interaction
    const activeInteractionKey = `interaction:active:${payload.conversationId}`;
    const activeInteractionId = await this.redis.get(activeInteractionKey);

    if (activeInteractionId) {
      logger.info(
        `Suppressing delta for thread ${payload.conversationId} - active interaction`
      );
      return null;
    }

    const streamTs = await this.streamSessionManager.handleDelta(
      sessionKey,
      payload.channelId,
      payload.conversationId,
      payload.userId,
      payload.delta,
      payload.isFullReplacement || false,
      payload.teamId
    );

    if (streamTs) {
      await this.setBotMessageTs(sessionKey, streamTs);
    }

    return streamTs;
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<void> {
    const hasActiveStream = this.streamSessionManager.hasSession(sessionKey);

    if (hasActiveStream) {
      logger.info(`Completing active stream for session ${sessionKey}`);
      await this.streamSessionManager.completeSession(sessionKey);
    } else {
      // Clear status even if no session exists
      try {
        const client = await this.getClientForTeam(payload.teamId);
        await client.apiCall("assistant.threads.setStatus", {
          channel_id: payload.channelId,
          thread_ts: payload.conversationId,
          status: "",
        });
      } catch (error) {
        logger.warn(`Failed to clear status: ${error}`);
      }
    }
  }

  async handleError(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<void> {
    if (!payload.error) return;

    // Stop any active stream before posting the error to avoid
    // Slack streaming_state_conflict rejections.
    if (this.streamSessionManager.hasSession(sessionKey)) {
      try {
        await this.streamSessionManager.completeSession(sessionKey);
      } catch (stopError) {
        logger.warn(
          `Failed to stop active stream before error delivery: ${stopError}`
        );
      }
    }

    const redisBotMessageTs = await this.getBotMessageTs(sessionKey);
    const existingBotMessageTs = payload.botResponseId || redisBotMessageTs;
    const isFirstResponse = !existingBotMessageTs;

    const actionButtons = await this.getModuleActionButtons(
      payload.userId,
      payload.channelId,
      payload.conversationId,
      payload.moduleData
    );

    const errorResult = this.blockBuilder.buildErrorBlocks(
      payload.error,
      actionButtons
    );

    const client = await this.getClientForTeam(payload.teamId);

    try {
      if (isFirstResponse) {
        await client.chat.postMessage({
          channel: payload.channelId,
          thread_ts: payload.conversationId,
          text: errorResult.text,
          mrkdwn: true,
          blocks: errorResult.blocks,
          unfurl_links: true,
          unfurl_media: true,
        });
      } else {
        const botTs =
          existingBotMessageTs ||
          payload.botResponseId ||
          payload.conversationId;
        await client.chat.update({
          channel: payload.channelId,
          ts: botTs,
          text: errorResult.text,
          blocks: errorResult.blocks,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Fallback: if update still hits a streaming conflict, post as new message
      if (
        errorMsg.includes("streaming_state_conflict") ||
        errorMsg.includes("message_not_in_streaming_state")
      ) {
        logger.warn(
          `Slack streaming conflict during error delivery, falling back to new message`
        );
        try {
          await client.chat.postMessage({
            channel: payload.channelId,
            thread_ts: payload.conversationId,
            text: errorResult.text,
            mrkdwn: true,
            blocks: errorResult.blocks,
          });
          return;
        } catch (fallbackError) {
          logger.error(`Fallback error message also failed: ${fallbackError}`);
          throw fallbackError;
        }
      }

      logger.error(`Failed to send error message to Slack: ${error}`);
      throw error;
    }
  }

  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.statusUpdate) return;

    // Don't update status if there's an active interaction
    const activeInteractionKey = `interaction:active:${payload.conversationId}`;
    const activeInteractionId = await this.redis.get(activeInteractionKey);

    if (activeInteractionId) {
      logger.debug(
        `Skipping status update for thread ${payload.conversationId} - active interaction`
      );
      return;
    }

    const statusText = `is ${payload.statusUpdate.state}...`;
    const loadingMessages = [
      `still ${payload.statusUpdate.state}... (${payload.statusUpdate.elapsedSeconds}s)`,
      `working on it... (${payload.statusUpdate.elapsedSeconds}s)`,
      `${payload.statusUpdate.state} your request... (${payload.statusUpdate.elapsedSeconds}s)`,
    ];

    try {
      const client = await this.getClientForTeam(payload.teamId);
      await client.apiCall("assistant.threads.setStatus", {
        channel_id: payload.channelId,
        thread_ts: payload.conversationId,
        status: statusText,
        loading_messages: loadingMessages,
      });
    } catch (error) {
      logger.warn(`Failed to update thread status: ${error}`);
    }
  }

  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.content) return;

    try {
      const { text, blocks } = await this.parseMessageContent(
        payload.content,
        payload
      );

      const client = await this.getClientForTeam(payload.teamId);
      await client.chat.postEphemeral({
        channel: payload.channelId,
        user: payload.userId,
        thread_ts: payload.conversationId,
        text,
        blocks,
      });
    } catch (error) {
      logger.error(`Failed to send ephemeral message: ${error}`);
      throw error;
    }
  }

  async stopStreamForConversation(
    _userId: string,
    conversationId: string
  ): Promise<void> {
    logger.info(`Stopping all streams for conversation ${conversationId}`);
    const stoppedCount =
      await this.streamSessionManager.completeAllSessionsForThread(
        conversationId,
        true
      );

    if (stoppedCount > 0) {
      logger.info(
        `Stopped ${stoppedCount} stream(s) for conversation ${conversationId}`
      );
    }
  }

  private async parseMessageContent(
    content: string,
    data: ThreadResponsePayload
  ): Promise<{ text: string; blocks: AnyBlock[] }> {
    try {
      const parsed = JSON.parse(content);
      if (parsed.blocks && Array.isArray(parsed.blocks)) {
        return {
          text: parsed.blocks[0]?.text?.text || "Authentication required",
          blocks: parsed.blocks,
        };
      }
    } catch {
      // Not JSON - continue to markdown processing
    }

    const { processedContent, actionButtons: codeBlockButtons } =
      extractCodeBlockActions(content);
    const text = convertMarkdownToSlack(processedContent);

    const moduleButtons = await this.getModuleActionButtons(
      data.userId,
      data.channelId,
      data.conversationId,
      data.moduleData
    );

    const allActionButtons = [...codeBlockButtons, ...moduleButtons];

    const result = this.blockBuilder.buildBlocks(text, {
      actionButtons: allActionButtons,
      includeActionButtons: true,
    });

    return { text: result.text, blocks: result.blocks };
  }

  private async getModuleActionButtons(
    userId: string,
    channelId: string,
    threadTs: string,
    moduleData?: Record<string, unknown>
  ): Promise<ModuleButton[]> {
    const dispatcherModules = this.moduleRegistry.getDispatcherModules();

    const buttonPromises = dispatcherModules.map(async (module) => {
      try {
        const moduleButtons = await module.generateActionButtons({
          userId,
          channelId,
          threadTs,
          platformClient: this.slackClient,
          moduleData: moduleData?.[module.name],
        });

        const validButtons: ModuleButton[] = [];
        for (const btn of moduleButtons) {
          if (!btn.text || !btn.action_id) {
            continue;
          }
          validButtons.push({
            text: btn.text,
            action_id: btn.action_id,
            style: btn.style,
            value: btn.value,
          });
        }
        return validButtons;
      } catch (error) {
        logger.error(
          `Failed to get action buttons from module ${module.name}:`,
          error
        );
        return [];
      }
    });

    const buttonArrays = await Promise.all(buttonPromises);
    return buttonArrays.flat();
  }
}
