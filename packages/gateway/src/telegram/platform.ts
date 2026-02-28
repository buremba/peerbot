/**
 * Telegram platform adapter implementing PlatformAdapter interface.
 */

import { Readable } from "node:stream";
import {
  type CommandRegistry,
  type AgentOptions as CoreAgentOptions,
  createLogger,
  type UserSuggestion,
} from "@lobu/core";
import { Bot } from "grammy";
import type { Hono } from "hono";
import { platformAuthRegistry } from "../auth/platform-auth";
import { CommandDispatcher } from "../commands/command-dispatcher";
import type { CoreServices, PlatformAdapter } from "../platform";
import type { IFileHandler } from "../platform/file-handler";
import {
  type AgentOptions as FactoryAgentOptions,
  type PlatformConfigs,
  type PlatformFactory,
  platformFactoryRegistry,
} from "../platform/platform-factory";
import type { ResponseRenderer } from "../platform/response-renderer";
import { TelegramAuthAdapter } from "./auth-adapter";
import type { TelegramConfig } from "./config";
import { shouldUseWebhook, TELEGRAM_WEBHOOK_PATH } from "./config";
import { TelegramMessageHandler } from "./events/message-handler";
import { TelegramFileHandler } from "./file-handler";
import { TelegramInteractionRenderer } from "./interactions";
import { TelegramResponseRenderer } from "./response-renderer";
import { createTelegramWebhookRoute } from "./webhook-route";

const logger = createLogger("telegram-platform");

export interface TelegramPlatformConfig {
  telegram: TelegramConfig;
}

export type AgentOptions = CoreAgentOptions;

/**
 * Telegram platform adapter.
 * Uses Grammy for Telegram Bot API integration.
 */
export class TelegramPlatform implements PlatformAdapter {
  readonly name = "telegram";

  private bot!: Bot;
  private messageHandler?: TelegramMessageHandler;
  private responseRenderer?: TelegramResponseRenderer;
  private interactionRenderer?: TelegramInteractionRenderer;
  private authAdapter?: TelegramAuthAdapter;
  private fileHandler?: TelegramFileHandler;
  private commandRegistry?: CommandRegistry;
  private running = false;
  private useWebhook = false;
  private webhookRoute?: Hono;

  constructor(
    private readonly config: TelegramPlatformConfig,
    private readonly agentOptions: AgentOptions,
    sessionTimeoutMinutes: number
  ) {
    // Reserved for future use (kept to match other platform constructors).
    void sessionTimeoutMinutes;
  }

  async initialize(services: CoreServices): Promise<void> {
    logger.info("Initializing Telegram platform...");

    // Create Grammy bot instance
    this.bot = new Bot(this.config.telegram.botToken);
    this.fileHandler = new TelegramFileHandler(
      this.bot,
      this.config.telegram.botToken
    );

    // Create message handler
    this.messageHandler = new TelegramMessageHandler(
      this.bot,
      this.config.telegram,
      services.getQueueProducer(),
      services.getSessionManager(),
      this.agentOptions
    );

    // Create response renderer
    this.responseRenderer = new TelegramResponseRenderer(
      this.bot,
      this.config.telegram
    );

    // Wire up conversation history tracking
    this.responseRenderer.setStoreOutgoingCallback((chatKey, text) => {
      this.messageHandler?.storeOutgoingMessage(chatKey, text);
    });

    // Create interaction renderer
    this.interactionRenderer = new TelegramInteractionRenderer(
      this.bot,
      services.getInteractionService()
    );

    // Register interaction callback handler
    this.interactionRenderer.registerCallbackHandler();

    // Create and register auth adapter
    const publicGatewayUrl = services.getPublicGatewayUrl();
    this.authAdapter = new TelegramAuthAdapter(this.bot, publicGatewayUrl);
    platformAuthRegistry.register("telegram", this.authAdapter);

    // Detect webhook vs polling mode
    this.useWebhook = shouldUseWebhook(publicGatewayUrl);

    logger.info("Telegram auth adapter registered");

    // Wire up channel binding service
    const channelBindingService = services.getChannelBindingService();
    if (channelBindingService && this.messageHandler) {
      this.messageHandler.setChannelBindingService(channelBindingService);
      logger.info("Channel binding service wired to Telegram message handler");
    }

    // Wire up agent settings store
    const agentSettingsStore = services.getAgentSettingsStore();
    if (agentSettingsStore && this.messageHandler) {
      this.messageHandler.setAgentSettingsStore(agentSettingsStore);
      logger.info("Agent settings store wired to Telegram message handler");
    }

    // Wire up command dispatcher
    const commandRegistry = services.getCommandRegistry();
    this.commandRegistry = commandRegistry;
    const commandDispatcher = new CommandDispatcher({
      registry: commandRegistry,
      channelBindingService: services.getChannelBindingService(),
    });
    if (this.messageHandler) {
      this.messageHandler.setCommandDispatcher(commandDispatcher);
      logger.info("Command dispatcher wired to Telegram message handler");
    }

    // Wire up user agent configuration stores
    if (this.messageHandler) {
      const userAgentsStore = services.getUserAgentsStore();
      const agentMetadataStore = services.getAgentMetadataStore();
      const adminStatusCache = services.getAdminStatusCache();
      this.messageHandler.setUserAgentsStore(userAgentsStore);
      this.messageHandler.setAgentMetadataStore(agentMetadataStore);
      this.messageHandler.setAdminStatusCache(adminStatusCache);
      logger.info(
        "User agents and admin status stores wired to Telegram message handler"
      );
    }

    logger.info("Telegram platform initialized");
  }

  async start(): Promise<void> {
    logger.info("Starting Telegram platform...");

    // Setup message handler before starting bot
    if (this.messageHandler) {
      this.messageHandler.start();
    }

    // Register bot commands menu with Telegram
    if (this.commandRegistry) {
      const commands = this.commandRegistry.getAll().map((cmd) => ({
        command: cmd.name,
        description: cmd.description,
      }));
      try {
        await this.bot.api.setMyCommands(commands);
        logger.info(
          { count: commands.length },
          "Telegram bot commands menu registered"
        );
      } catch (err) {
        logger.warn(
          { error: String(err) },
          "Failed to set Telegram bot commands menu"
        );
      }
    }

    // Register error handler
    this.bot.catch((err) => {
      logger.error({ error: String(err) }, "Grammy bot error");
    });

    if (this.useWebhook) {
      // Build full webhook URL
      const publicGatewayUrl = process.env.PUBLIC_GATEWAY_URL!;
      const webhookUrl = `${publicGatewayUrl.replace(/\/$/, "")}${TELEGRAM_WEBHOOK_PATH}`;

      try {
        await this.bot.api.setWebhook(webhookUrl, {
          secret_token: this.config.telegram.webhookSecret,
        });
        // Create webhook route only after setWebhook succeeds — calling
        // webhookCallback() marks the bot as "webhook mode" in Grammy,
        // which would block a fallback to bot.start() (long polling).
        this.webhookRoute = createTelegramWebhookRoute(
          this.bot,
          this.config.telegram.webhookSecret
        );
        this.running = true;
        logger.info({ webhookUrl }, "Telegram bot started (webhook mode)");
      } catch (err) {
        logger.warn(
          { error: String(err), webhookUrl },
          "Failed to set Telegram webhook, falling back to long polling"
        );
        this.useWebhook = false;
        // Delete any existing webhook before starting long polling
        try {
          await this.bot.api.deleteWebhook();
        } catch (e) {
          logger.debug(
            { error: String(e) },
            "Could not delete webhook before fallback polling"
          );
        }
        this.bot.start({
          onStart: () => {
            this.running = true;
            logger.info(
              "Telegram bot started (long polling, webhook fallback)"
            );
          },
        });
      }
    } else {
      // Delete any existing webhook before starting long polling
      try {
        await this.bot.api.deleteWebhook();
      } catch (e) {
        logger.debug(
          { error: String(e) },
          "Could not delete webhook before polling"
        );
      }
      this.bot.start({
        onStart: () => {
          this.running = true;
          logger.info("Telegram bot started (long polling)");
        },
      });
    }

    logger.info("Telegram platform started");
  }

  async stop(): Promise<void> {
    logger.info("Stopping Telegram platform...");

    if (this.messageHandler) {
      this.messageHandler.stop();
    }

    if (this.responseRenderer) {
      this.responseRenderer.cleanup();
    }

    if (this.useWebhook) {
      await this.bot.api.deleteWebhook();
    } else {
      this.bot.stop();
    }
    this.running = false;

    logger.info("Telegram platform stopped");
  }

  isHealthy(): boolean {
    return this.running;
  }

  getWebhookRoute(): Hono | undefined {
    return this.webhookRoute;
  }

  getResponseRenderer(): ResponseRenderer | undefined {
    return this.responseRenderer;
  }

  getFileHandler(): IFileHandler | undefined {
    return this.fileHandler;
  }

  buildDeploymentMetadata(
    conversationId: string,
    channelId: string,
    platformMetadata: Record<string, any>
  ): Record<string, string> {
    return {
      chat_id: String(platformMetadata?.chatId || channelId),
      conversation_id: conversationId,
      is_group: String(platformMetadata?.isGroup || false),
    };
  }

  async renderSuggestion(suggestion: UserSuggestion): Promise<void> {
    if (this.interactionRenderer) {
      await this.interactionRenderer.renderSuggestion(suggestion);
    }
  }

  async setThreadStatus(
    channelId: string,
    _conversationId: string,
    status: string | null
  ): Promise<void> {
    if (status && this.bot) {
      try {
        await this.bot.api.sendChatAction(Number(channelId), "typing");
      } catch {
        // Ignore typing indicator errors
      }
    }
  }

  isOwnBotToken(_token: string): boolean {
    return false;
  }

  async sendMessage(
    _token: string,
    message: string,
    options: {
      agentId: string;
      channelId: string;
      conversationId?: string;
      teamId: string;
      files?: Array<{ buffer: Buffer; filename: string }>;
    }
  ): Promise<{
    messageId: string;
    eventsUrl?: string;
    queued?: boolean;
  }> {
    const chatId = Number(options.channelId);

    // Clean @me mention
    const cleanMessage = message.replace(/@me\s*/g, "").trim();

    if (options.files && options.files.length > 0) {
      if (!this.fileHandler) {
        throw new Error("Telegram file handler is not initialized");
      }

      let firstMessageId: string | null = null;
      for (const [index, file] of options.files.entries()) {
        const result = await this.fileHandler.uploadFile(
          Readable.from(file.buffer),
          {
            filename: file.filename,
            channelId: options.channelId,
            threadTs: options.conversationId,
            initialComment: index === 0 ? cleanMessage || undefined : undefined,
          }
        );

        if (!firstMessageId) {
          const permalinkMatch = /message_id=(\d+)/.exec(result.permalink);
          firstMessageId = permalinkMatch?.[1] || result.fileId;
        }
      }

      return { messageId: firstMessageId || String(Date.now()) };
    }

    if (!cleanMessage) {
      throw new Error("Cannot send empty message without files");
    }

    const sent = await this.bot.api.sendMessage(chatId, cleanMessage);

    return {
      messageId: String(sent.message_id),
    };
  }

  isGroupChannel(channelId: string): boolean {
    // Telegram group chat IDs are negative
    const chatId = Number(channelId);
    return chatId < 0;
  }

  getDisplayInfo(): { name: string; icon: string; logoUrl?: string } {
    return {
      name: "Telegram",
      icon: `<svg viewBox="0 0 24 24" fill="#26A5E4" xmlns="http://www.w3.org/2000/svg"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`,
    };
  }

  extractRoutingInfo(body: Record<string, unknown>): {
    channelId: string;
    conversationId: string;
    teamId?: string;
  } | null {
    const telegram = body.telegram as { chatId?: string | number } | undefined;
    if (!telegram?.chatId) return null;

    return {
      channelId: String(telegram.chatId),
      conversationId: String(telegram.chatId),
    };
  }

  async getConversationHistory(
    channelId: string,
    _conversationId: string | undefined,
    limit: number,
    before: string | undefined
  ): Promise<{
    messages: Array<{
      timestamp: string;
      user: string;
      text: string;
      isBot?: boolean;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    if (!this.messageHandler) {
      return { messages: [], nextCursor: null, hasMore: false };
    }

    return this.messageHandler.getHistory(channelId, limit, before);
  }
}

/**
 * Telegram platform factory for declarative registration.
 */
const telegramFactory: PlatformFactory = {
  name: "telegram",

  isEnabled(configs: PlatformConfigs): boolean {
    return configs.telegram?.enabled === true;
  },

  create(
    configs: PlatformConfigs,
    agentOptions: FactoryAgentOptions,
    sessionTimeoutMinutes: number
  ) {
    const platformConfig: TelegramPlatformConfig = {
      telegram: configs.telegram,
    };
    return new TelegramPlatform(
      platformConfig,
      agentOptions,
      sessionTimeoutMinutes
    );
  },
};

// Register factory on module load
platformFactoryRegistry.register(telegramFactory);
