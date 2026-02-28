/**
 * Telegram message handler.
 * Processes inbound messages and enqueues them for worker processing.
 */

import {
  type AgentOptions as CoreAgentOptions,
  createLogger,
  generateTraceId,
} from "@lobu/core";
import type { Bot } from "grammy";
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
import { createTelegramReply } from "../../commands/command-reply-adapters";
import type {
  MessagePayload,
  QueueProducer,
} from "../../infrastructure/queue/queue-producer";
import type { ISessionManager } from "../../session";
import { resolveSpace } from "../../spaces";
import type { TelegramConfig } from "../config";
import { isGroupChat, type TelegramContext } from "../types";

const logger = createLogger("telegram-message-handler");

type AgentOptions = CoreAgentOptions;

interface StoredMessage {
  id: string;
  text: string;
  fromMe: boolean;
  senderName?: string;
  timestamp: number;
}

interface ConversationHistory {
  messages: StoredMessage[];
  lastUpdated: number;
}

/**
 * Telegram message handler.
 */
export class TelegramMessageHandler {
  private seen = new Set<number>();
  private conversationHistory = new Map<string, ConversationHistory>();
  private isRunning = false;
  private historyCleanupTimer?: NodeJS.Timeout;
  private channelBindingService?: ChannelBindingService;
  private agentSettingsStore?: AgentSettingsStore;
  private userAgentsStore?: UserAgentsStore;
  private agentMetadataStore?: AgentMetadataStore;
  private adminStatusCache?: AdminStatusCache;
  private commandDispatcher?: CommandDispatcher;
  private botUsername?: string;

  constructor(
    private bot: Bot,
    private config: TelegramConfig,
    private queueProducer: QueueProducer,
    _sessionManager: ISessionManager,
    private agentOptions: AgentOptions
  ) {}

  setChannelBindingService(service: ChannelBindingService): void {
    this.channelBindingService = service;
  }

  setAgentSettingsStore(store: AgentSettingsStore): void {
    this.agentSettingsStore = store;
  }

  setUserAgentsStore(store: UserAgentsStore): void {
    this.userAgentsStore = store;
  }

  setAgentMetadataStore(store: AgentMetadataStore): void {
    this.agentMetadataStore = store;
  }

  setAdminStatusCache(cache: AdminStatusCache): void {
    this.adminStatusCache = cache;
  }

  setCommandDispatcher(dispatcher: CommandDispatcher): void {
    this.commandDispatcher = dispatcher;
  }

  /**
   * Get agent options with settings applied.
   */
  private async getAgentOptionsWithSettings(
    agentId: string
  ): Promise<Record<string, any>> {
    const baseOptions = { ...this.agentOptions };

    if (!this.agentSettingsStore) {
      return baseOptions;
    }

    const settings = await this.agentSettingsStore.getSettings(agentId);
    if (!settings) {
      return baseOptions;
    }

    logger.info({ agentId, model: settings.model }, "Applying agent settings");

    const mergedOptions: Record<string, any> = { ...baseOptions };

    if (settings.model) {
      mergedOptions.model = settings.model;
    } else if ((settings.installedProviders?.length ?? 0) > 0) {
      // Agent has providers installed but no explicit model - clear the
      // global default so auto-mode picks the primary installed provider.
      delete mergedOptions.model;
    }
    if (settings.networkConfig) {
      mergedOptions.networkConfig = settings.networkConfig;
    }
    if (settings.nixConfig) {
      mergedOptions.nixConfig = settings.nixConfig;
    }
    if (settings.envVars) {
      mergedOptions.envVars = settings.envVars;
    }
    if (settings.toolsConfig) {
      mergedOptions.toolsConfig = settings.toolsConfig;
    }
    if (settings.mcpServers) {
      mergedOptions.mcpServers = settings.mcpServers;
    }
    if (settings.pluginsConfig) {
      mergedOptions.pluginsConfig = settings.pluginsConfig;
    }
    if (settings.verboseLogging !== undefined) {
      mergedOptions.verboseLogging = settings.verboseLogging;
    }

    return mergedOptions;
  }

  /**
   * Start listening for messages.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Fetch bot info for mention detection
    this.bot.api.getMe().then((me) => {
      this.botUsername = me.username;
      logger.info({ botUsername: this.botUsername }, "Bot username resolved");
    });

    this.bot.on("message:text", async (ctx) => {
      try {
        await this.processMessage(ctx);
      } catch (err) {
        logger.error({ error: String(err) }, "Error handling text message");
      }
    });

    // Periodically cleanup expired histories
    if (this.historyCleanupTimer) {
      clearInterval(this.historyCleanupTimer);
    }
    this.historyCleanupTimer = setInterval(
      () => this.cleanupExpiredHistories(),
      60 * 60 * 1000
    );

    logger.info("Telegram message handler started");
  }

  /**
   * Stop listening for messages.
   */
  stop(): void {
    this.isRunning = false;
    if (this.historyCleanupTimer) {
      clearInterval(this.historyCleanupTimer);
      this.historyCleanupTimer = undefined;
    }
    logger.info("Telegram message handler stopped");
  }

  /**
   * Process a single message.
   */
  private async processMessage(ctx: any): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const messageId = msg.message_id;

    // Dedupe
    if (this.seen.has(messageId)) {
      logger.debug({ messageId }, "Skipping duplicate message");
      return;
    }
    this.seen.add(messageId);

    // Trim seen set to prevent memory growth
    if (this.seen.size > 10000) {
      const iterator = this.seen.values();
      for (let i = 0; i < 5000; i++) {
        const val = iterator.next().value;
        if (val !== undefined) this.seen.delete(val);
      }
    }

    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const isGroup = isGroupChat(chatType);
    const senderId = msg.from?.id ?? 0;
    const senderUsername = msg.from?.username;
    const senderDisplayName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
      undefined;

    const body = msg.text || "";

    logger.info(
      {
        messageId,
        chatId,
        chatType,
        senderId,
        isGroup,
        body: body.substring(0, 100),
      },
      "Processing message"
    );

    // Authorization check
    if (!this.isAllowedSender(senderId)) {
      logger.info(
        { senderId, allowFrom: this.config.allowFrom },
        "Blocked unauthorized sender"
      );
      return;
    }

    // Groups always require @mention; DMs never do
    if (isGroup && !this.isBotMentioned(msg)) {
      return;
    }

    // Check if groups are allowed
    if (isGroup && !this.config.allowGroups) {
      return;
    }

    // Build context
    const context: TelegramContext = {
      senderId,
      senderUsername,
      senderDisplayName,
      chatId,
      chatType,
      isGroup,
      messageId,
      messageThreadId: msg.message_thread_id,
      repliedMessage: msg.reply_to_message
        ? {
            id: msg.reply_to_message.message_id,
            body: msg.reply_to_message.text || "",
            sender:
              msg.reply_to_message.from?.username ||
              String(msg.reply_to_message.from?.id || "unknown"),
          }
        : undefined,
    };

    // Store in conversation history
    const chatKey = String(chatId);
    this.storeMessageInHistory(chatKey, {
      id: String(messageId),
      text: body,
      fromMe: false,
      senderName: senderDisplayName,
      timestamp: (msg.date || 0) * 1000,
    });

    // Get conversation history
    const conversationHistory = this.getConversationHistory(chatKey);

    // Enqueue for processing
    await this.enqueueMessage(
      String(messageId),
      body,
      context,
      conversationHistory
    );
  }

  /**
   * Check if sender is allowed.
   */
  private isAllowedSender(senderId: number): boolean {
    const { allowFrom } = this.config;

    // Empty allowFrom means allow all
    if (!allowFrom || allowFrom.length === 0) {
      return true;
    }

    // Check wildcard
    if (allowFrom.includes("*")) {
      return true;
    }

    return allowFrom.includes(String(senderId));
  }

  /**
   * Check if the bot was mentioned in the message.
   */
  private isBotMentioned(msg: any): boolean {
    if (!this.botUsername) return false;

    // Check text for @username
    const text = msg.text || "";
    if (text.includes(`@${this.botUsername}`)) {
      return true;
    }

    // Check entities for bot_command or mention
    const entities = msg.entities || [];
    for (const entity of entities) {
      if (entity.type === "mention") {
        const mentionText = text.substring(
          entity.offset,
          entity.offset + entity.length
        );
        if (mentionText === `@${this.botUsername}`) {
          return true;
        }
      }
      if (entity.type === "bot_command") {
        return true;
      }
    }

    return false;
  }

  /**
   * Enqueue message for worker processing.
   */
  private async enqueueMessage(
    messageId: string,
    body: string,
    context: TelegramContext,
    conversationHistory: Array<{
      role: "user" | "assistant";
      content: string;
      name?: string;
    }>
  ): Promise<void> {
    const conversationId = context.isGroup
      ? context.repliedMessage
        ? String(context.repliedMessage.id)
        : messageId
      : String(context.chatId);

    const traceId = generateTraceId(messageId);
    const userId = String(context.senderId);
    const chatId = String(context.chatId);

    // Handle slash commands via shared dispatcher before normal message routing
    if (this.commandDispatcher) {
      const handled = await this.commandDispatcher.tryHandleSlashText(body, {
        platform: "telegram",
        userId,
        channelId: chatId,
        isGroup: context.isGroup,
        conversationId,
        reply: createTelegramReply(this.bot, context.chatId),
      });
      if (handled) return;
    }

    logger.info(
      { traceId, messageId, conversationId, userId },
      "Message received"
    );

    // Resolve agent ID
    let agentId: string;
    if (this.channelBindingService) {
      const binding = await this.channelBindingService.getBinding(
        "telegram",
        chatId
      );
      if (binding) {
        agentId = binding.agentId;
        logger.info({ agentId, chatId }, "Using bound agentId");
      } else {
        // No binding - send configuration prompt
        const sent = await this.sendConfigurationPrompt(context);
        if (sent) return;

        // Fallback if config prompt fails
        const space = resolveSpace({
          platform: "telegram",
          userId,
          channelId: chatId,
          isGroup: context.isGroup,
        });
        agentId = space.agentId;
        logger.info({ agentId }, "Fallback resolved agentId");
      }
    } else {
      const space = resolveSpace({
        platform: "telegram",
        userId,
        channelId: chatId,
        isGroup: context.isGroup,
      });
      agentId = space.agentId;
    }

    // Clean up body - remove bot mention
    let cleanBody = body;
    if (this.botUsername) {
      cleanBody = cleanBody.replace(`@${this.botUsername}`, "").trim();
    }

    // Fetch agent settings and merge
    const agentOptions = await this.getAgentOptionsWithSettings(agentId);
    const { networkConfig, nixConfig, mcpServers, ...remainingOptions } =
      agentOptions;

    const payload: MessagePayload = {
      platform: "telegram",
      userId,
      botId: "telegram",
      conversationId,
      teamId: context.isGroup ? chatId : "telegram",
      agentId,
      messageId,
      messageText: cleanBody,
      channelId: chatId,
      platformMetadata: {
        traceId,
        agentId,
        chatId: context.chatId,
        senderId: context.senderId,
        senderUsername: context.senderUsername,
        senderDisplayName: context.senderDisplayName,
        isGroup: context.isGroup,
        chatType: context.chatType,
        messageThreadId: context.messageThreadId,
        repliedMessageId: context.repliedMessage?.id,
        responseChannel: chatId,
        responseId: messageId,
        conversationHistory:
          conversationHistory.length > 0 ? conversationHistory : undefined,
      },
      agentOptions: remainingOptions,
      networkConfig,
      nixConfig,
      mcpConfig: mcpServers ? { mcpServers } : undefined,
    };

    await this.queueProducer.enqueueMessage(payload);
    logger.info(
      {
        traceId,
        messageId,
        conversationId,
        chatId,
        historyCount: conversationHistory.length,
      },
      "Message enqueued"
    );
  }

  /**
   * Send a configuration prompt when no agent is bound.
   * Returns true if sent (caller should stop), false if failed (caller should fallback).
   */
  private async sendConfigurationPrompt(
    context: TelegramContext
  ): Promise<boolean> {
    if (!this.userAgentsStore || !this.agentMetadataStore) {
      return false;
    }

    try {
      const userId = String(context.senderId);
      const chatId = String(context.chatId);

      // For groups, check admin permissions
      if (context.isGroup) {
        const canConfigure = await this.checkCanConfigureTelegram(
          chatId,
          userId
        );
        if (!canConfigure.allowed) {
          await this.bot.api.sendMessage(
            context.chatId,
            canConfigure.reason ||
              "Only group admins can configure the bot for this group."
          );
          return true;
        }
      }

      const token = generateChannelSettingsToken(userId, "telegram", chatId);
      const configUrl = buildSettingsUrl(token);

      // Telegram rejects inline keyboard URLs like http://localhost:...; fall back to plain text in that case.
      let includeButton = true;
      try {
        const u = new URL(configUrl);
        if (
          u.hostname === "localhost" ||
          u.hostname === "127.0.0.1" ||
          u.hostname === "::1"
        ) {
          includeButton = false;
        }
      } catch {
        includeButton = false;
      }

      if (includeButton) {
        await this.bot.api.sendMessage(
          context.chatId,
          `Welcome! To get started, please configure which agent should handle messages here.\n\nConfigure: ${configUrl}`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Configure Agent",
                    url: configUrl,
                  },
                ],
              ],
            },
          }
        );
      } else {
        await this.bot.api.sendMessage(
          context.chatId,
          `Welcome! To get started, please configure which agent should handle messages here.\n\nConfigure: ${configUrl}`
        );
      }

      logger.info(
        { userId, chatId: context.chatId },
        "Sent configuration prompt"
      );
      return true;
    } catch (error) {
      logger.error({ error }, "Failed to send configuration prompt");
      return false;
    }
  }

  /**
   * Check if a Telegram user can configure a group.
   */
  private async checkCanConfigureTelegram(
    chatId: string,
    userId: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Check cache
    if (this.adminStatusCache) {
      const cached = await this.adminStatusCache.getStatus(
        "telegram",
        chatId,
        userId
      );
      if (cached !== null) {
        return cached
          ? { allowed: true }
          : {
              allowed: false,
              reason: "Only group admins can configure the bot for this group.",
            };
      }
    }

    try {
      const member = await this.bot.api.getChatMember(
        Number(chatId),
        Number(userId)
      );
      const isAdmin =
        member.status === "creator" || member.status === "administrator";

      // Cache result
      if (this.adminStatusCache) {
        await this.adminStatusCache.setStatus(
          "telegram",
          chatId,
          userId,
          isAdmin
        );
      }

      if (isAdmin) {
        return { allowed: true };
      }

      return {
        allowed: false,
        reason: "Only group admins can configure the bot for this group.",
      };
    } catch (error) {
      logger.warn({ error, chatId, userId }, "Failed Telegram admin check");
      // Fallback to first-user
      if (this.channelBindingService) {
        const existing = await this.channelBindingService.getBinding(
          "telegram",
          chatId
        );
        if (!existing) {
          return { allowed: true };
        }
      }
      return { allowed: true };
    }
  }

  /**
   * Store a message in conversation history.
   */
  private storeMessageInHistory(chatKey: string, message: StoredMessage): void {
    const history = this.conversationHistory.get(chatKey) || {
      messages: [],
      lastUpdated: Date.now(),
    };

    history.messages.push(message);
    history.lastUpdated = Date.now();

    while (history.messages.length > this.config.maxHistoryMessages) {
      history.messages.shift();
    }

    this.conversationHistory.set(chatKey, history);
  }

  /**
   * Get conversation history for a chat.
   */
  private getConversationHistory(chatKey: string): Array<{
    role: "user" | "assistant";
    content: string;
    name?: string;
  }> {
    const history = this.conversationHistory.get(chatKey);
    if (!history) return [];

    const ttlMs = this.config.historyTtlSeconds * 1000;
    if (Date.now() - history.lastUpdated > ttlMs) {
      this.conversationHistory.delete(chatKey);
      return [];
    }

    return history.messages.map((msg) => ({
      role: msg.fromMe ? ("assistant" as const) : ("user" as const),
      content: msg.text,
      name: msg.senderName,
    }));
  }

  /**
   * Store an outgoing (bot) message in history.
   */
  storeOutgoingMessage(chatKey: string, text: string): void {
    this.storeMessageInHistory(chatKey, {
      id: `outgoing_${Date.now()}`,
      text,
      fromMe: true,
      timestamp: Date.now(),
    });
  }

  /**
   * Get conversation history for API endpoint.
   */
  getHistory(
    chatKey: string,
    limit: number,
    before?: string
  ): {
    messages: Array<{
      timestamp: string;
      user: string;
      text: string;
      isBot?: boolean;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  } {
    const history = this.conversationHistory.get(chatKey);
    if (!history) {
      return { messages: [], nextCursor: null, hasMore: false };
    }

    const ttlMs = this.config.historyTtlSeconds * 1000;
    if (Date.now() - history.lastUpdated > ttlMs) {
      this.conversationHistory.delete(chatKey);
      return { messages: [], nextCursor: null, hasMore: false };
    }

    let messages = history.messages;
    if (before) {
      const beforeTs = new Date(before).getTime();
      messages = messages.filter((m) => m.timestamp < beforeTs);
    }

    const sorted = [...messages]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    const formatted = sorted.map((msg) => ({
      timestamp: new Date(msg.timestamp).toISOString(),
      user: msg.senderName || (msg.fromMe ? "Assistant" : "User"),
      text: msg.text,
      isBot: msg.fromMe,
    }));

    const hasMore = messages.length > limit;
    const lastMessage = sorted[sorted.length - 1];
    const nextCursor =
      hasMore && lastMessage
        ? new Date(lastMessage.timestamp).toISOString()
        : null;

    return { messages: formatted, nextCursor, hasMore };
  }

  /**
   * Cleanup expired conversation histories.
   */
  private cleanupExpiredHistories(): void {
    const now = Date.now();
    const ttlMs = this.config.historyTtlSeconds * 1000;

    for (const [chatKey, history] of this.conversationHistory) {
      if (now - history.lastUpdated > ttlMs) {
        this.conversationHistory.delete(chatKey);
      }
    }
  }
}
