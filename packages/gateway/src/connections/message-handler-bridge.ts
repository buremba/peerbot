/**
 * Message handler bridge — connects Chat SDK events to the message queue.
 * Bridges all 9 feature gaps: history, agent auto-creation, provider setup,
 * settings links, allowlist, audio transcription, etc.
 */

import { createLogger, generateTraceId } from "@lobu/core";
import type Redis from "ioredis";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { createChatReply } from "../commands/command-reply-adapters";
import type { CoreServices } from "../platform";
import {
  buildMessagePayload,
  hasConfiguredProvider,
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers";
import type { ChatInstanceManager } from "./chat-instance-manager";
import type { PlatformConnection } from "./types";

const logger = createLogger("chat-message-bridge");

const MAX_HISTORY_MESSAGES = 10;
const HISTORY_TTL_SECONDS = 86400; // 24 hours

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  authorName?: string;
  timestamp: number;
}

export function isSenderAllowed(
  allowFrom: string[] | undefined,
  userId: string
): boolean {
  if (!Array.isArray(allowFrom)) {
    return true;
  }
  return allowFrom.includes(userId);
}

/**
 * Register Chat SDK event handlers for a connection.
 */
export function registerMessageHandlers(
  chat: any,
  connection: PlatformConnection,
  services: CoreServices,
  manager: ChatInstanceManager,
  commandDispatcher?: CommandDispatcher
): void {
  const handler = new MessageHandlerBridge(
    connection,
    services,
    manager,
    commandDispatcher
  );

  chat.onNewMention(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "mention");
  });

  chat.onDirectMessage(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "dm");
  });

  chat.onSubscribedMessage(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "subscribed");
  });
}

class MessageHandlerBridge {
  private redis: Redis;

  constructor(
    private connection: PlatformConnection,
    private services: CoreServices,
    private manager: ChatInstanceManager,
    private commandDispatcher?: CommandDispatcher
  ) {
    this.redis = services.getQueue().getRedisClient();
  }

  async handleMessage(
    thread: any,
    message: any,
    source: "mention" | "dm" | "subscribed"
  ): Promise<void> {
    const { connection } = this;

    // Guard: drop messages if the connection was stopped/removed
    if (!this.manager.has(connection.id)) {
      logger.info(
        { connectionId: connection.id },
        "Connection no longer active, dropping message"
      );
      return;
    }

    const platform = connection.platform;
    const userId = message.author?.userId ?? "unknown";
    const channelId = thread.channelId ?? thread.id ?? "unknown";
    const messageId = message.id ?? String(Date.now());
    const isGroup = source === "mention" || source === "subscribed";

    logger.info(
      {
        connectionId: connection.id,
        platform,
        userId,
        channelId,
        messageId,
        source,
      },
      "Processing inbound message"
    );

    // Gap 6: Allowlist check
    if (!isSenderAllowed(connection.settings?.allowFrom, userId)) {
      logger.info({ userId }, "Blocked by allowlist");
      return;
    }

    // Gap 6: Group check
    if (isGroup && connection.settings?.allowGroups === false) {
      logger.info({ channelId }, "Groups not allowed");
      return;
    }

    // Subscribe to thread for follow-up messages
    if (source === "mention" || source === "dm") {
      try {
        await thread.subscribe();
      } catch {
        // some platforms may not support subscribe
      }
    }

    // Gap 2: Resolve agent ID
    const { agentId } = await resolveAgentId({
      platform,
      userId,
      channelId,
      isGroup,
    });

    // Gap 2: Auto-create agent metadata
    const agentMetadataStore = this.services.getAgentMetadataStore();
    const userAgentsStore = this.services.getUserAgentsStore();
    if (agentMetadataStore) {
      const existing = await agentMetadataStore.getMetadata(agentId);
      if (!existing) {
        const agentName = isGroup
          ? `${platform} Group ${channelId}`
          : `${platform} ${message.author?.fullName || userId}`;
        await agentMetadataStore.createAgent(
          agentId,
          agentName,
          platform,
          userId,
          { parentConnectionId: this.connection.id }
        );
        await userAgentsStore?.addAgent(platform, userId, agentId);
        logger.info({ agentId, userId }, "Auto-created agent");

        // Clone settings from template agent if connection has one
        if (this.connection.templateAgentId) {
          try {
            const agentSettingsStore = this.services.getAgentSettingsStore();
            if (agentSettingsStore) {
              const templateSettings = await agentSettingsStore.getSettings(
                this.connection.templateAgentId
              );
              if (templateSettings) {
                const { buildDefaultSettingsFromSource } = await import(
                  "../auth/settings/template-utils"
                );
                const cloned = buildDefaultSettingsFromSource(templateSettings);
                cloned.templateAgentId = this.connection.templateAgentId;
                await agentSettingsStore.saveSettings(agentId, cloned);
                logger.info(
                  {
                    agentId,
                    templateAgentId: this.connection.templateAgentId,
                  },
                  "Cloned settings from template agent"
                );
              }
            }
          } catch (error) {
            logger.warn(
              {
                agentId,
                templateAgentId: this.connection.templateAgentId,
                error: String(error),
              },
              "Failed to clone template agent settings"
            );
          }
        }
      }
    }

    // Gap 7: Audio transcription
    let messageText = message.text ?? "";
    const transcriptionService = this.services.getTranscriptionService();
    if (transcriptionService && message.attachments?.length) {
      for (const attachment of message.attachments) {
        const mime = attachment.mimeType ?? "";
        if (
          mime.startsWith("audio/") ||
          mime === "application/ogg" ||
          mime.startsWith("video/note")
        ) {
          try {
            const data = await attachment.fetchData?.();
            if (data) {
              const result = await transcriptionService.transcribe(
                Buffer.from(data),
                agentId,
                mime
              );
              if ("text" in result && result.text) {
                messageText = messageText
                  ? `${messageText}\n\n[Voice message]: ${result.text}`
                  : result.text;
              }
            }
          } catch (error) {
            logger.warn(
              { error: String(error), messageId },
              "Audio transcription failed"
            );
          }
        }
      }
    }

    // Remove bot mention from text
    const botUsername = this.manager.getInstance(this.connection.id)?.connection
      .metadata.botUsername;
    if (botUsername) {
      messageText = messageText.replace(`@${botUsername}`, "").trim();
    }

    // Intercept /new and /clear before slash dispatch
    let sessionReset = false;
    const trimmedLower = messageText.trim().toLowerCase();
    if (trimmedLower === "/new") {
      messageText = "Starting new session.";
      sessionReset = true;
    } else if (trimmedLower === "/clear") {
      const historyKey = `chat:history:${this.connection.id}:${channelId}`;
      await this.redis.del(historyKey);
      await thread.post({ text: "Chat history cleared." });
      return;
    }

    // Slash command dispatch — intercept before queueing to worker
    if (!sessionReset && this.commandDispatcher) {
      const handled = await this.commandDispatcher.tryHandleSlashText(
        messageText,
        {
          platform,
          userId,
          channelId,
          isGroup,
          conversationId: messageId,
          connectionId: this.connection.id,
          reply: createChatReply((content) => thread.post(content)),
        }
      );
      if (handled) return;
    }

    // Gap 1: Retrieve conversation history from Redis
    const historyKey = `chat:history:${this.connection.id}:${channelId}`;
    const conversationHistory = await this.getHistory(historyKey);

    // Gap 1: Store inbound message
    await this.appendHistory(historyKey, {
      role: "user",
      content: messageText,
      authorName: message.author?.fullName,
      timestamp: Date.now(),
    });

    // Build payload and enqueue
    const traceId = generateTraceId(messageId);
    const agentSettingsStore = this.services.getAgentSettingsStore();

    // Check if agent has any provider credentials before enqueuing
    if (!(await hasConfiguredProvider(agentId, agentSettingsStore))) {
      await thread.post(
        "No AI provider is configured yet. Provider setup is not available in the end-user chat flow yet. Ask an admin to connect a provider for the base agent."
      );
      return;
    }

    const agentOptions = await resolveAgentOptions(
      agentId,
      {},
      agentSettingsStore
    );

    const payload = buildMessagePayload({
      platform,
      userId,
      botId: platform,
      conversationId: isGroup ? messageId : channelId,
      teamId: isGroup ? channelId : platform,
      agentId,
      messageId,
      messageText,
      channelId,
      platformMetadata: {
        traceId,
        agentId,
        chatId: channelId,
        senderId: userId,
        senderUsername: message.author?.userName,
        senderDisplayName: message.author?.fullName,
        isGroup,
        connectionId: this.connection.id,
        responseChannel: channelId,
        responseId: messageId,
        responseThreadId: thread.id,
        conversationHistory:
          conversationHistory.length > 0 ? conversationHistory : undefined,
        ...(sessionReset && { sessionReset: true }),
      },
      agentOptions,
    });

    const queueProducer = this.services.getQueueProducer();
    await queueProducer.enqueueMessage(payload);

    logger.info(
      { traceId, messageId, agentId, connectionId: this.connection.id },
      "Message enqueued via Chat SDK bridge"
    );

    // Show typing indicator
    try {
      await thread.startTyping?.("Processing...");
    } catch {
      // best effort
    }
  }

  // Gap 1: Redis-backed conversation history

  private async getHistory(
    key: string
  ): Promise<
    Array<{ role: "user" | "assistant"; content: string; name?: string }>
  > {
    const raw = await this.redis.lrange(key, 0, MAX_HISTORY_MESSAGES - 1);
    const results: Array<{
      role: "user" | "assistant";
      content: string;
      name?: string;
    }> = [];
    for (const entry of raw) {
      try {
        const parsed = JSON.parse(entry) as HistoryEntry;
        results.push({
          role: parsed.role,
          content: parsed.content,
          name: parsed.authorName,
        });
      } catch (err) {
        logger.warn(
          { key, error: String(err) },
          "Skipping corrupt history entry"
        );
      }
    }
    return results;
  }

  private async appendHistory(key: string, entry: HistoryEntry): Promise<void> {
    await this.redis
      .pipeline()
      .rpush(key, JSON.stringify(entry))
      .ltrim(key, -MAX_HISTORY_MESSAGES, -1)
      .expire(key, HISTORY_TTL_SECONDS)
      .exec();
  }
}

/**
 * Store an outgoing bot response in conversation history.
 * Called from the response bridge.
 */
export async function storeOutgoingHistory(
  redis: Redis,
  connectionId: string,
  channelId: string,
  text: string
): Promise<void> {
  const key = `chat:history:${connectionId}:${channelId}`;
  const entry: HistoryEntry = {
    role: "assistant",
    content: text,
    timestamp: Date.now(),
  };
  await redis
    .pipeline()
    .rpush(key, JSON.stringify(entry))
    .ltrim(key, -MAX_HISTORY_MESSAGES, -1)
    .expire(key, HISTORY_TTL_SECONDS)
    .exec();
}
