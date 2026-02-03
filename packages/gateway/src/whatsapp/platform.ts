/**
 * WhatsApp platform adapter implementing PlatformAdapter interface.
 */

import {
  createLogger,
  type UserInteraction,
  type UserSuggestion,
} from "@peerbot/core";
import { platformAuthRegistry } from "../auth/platform-auth";
import type { CoreServices, PlatformAdapter } from "../platform";
import type { IFileHandler } from "../platform/file-handler";
import {
  type AgentOptions as FactoryAgentOptions,
  type PlatformConfigs,
  type PlatformFactory,
  platformFactoryRegistry,
} from "../platform/platform-factory";
import type { ResponseRenderer } from "../platform/response-renderer";
import { WhatsAppAuthAdapter } from "./auth-adapter";
import type { WhatsAppConfig } from "./config";
import { BaileysClient } from "./connection/baileys-client";
import { WhatsAppMessageHandler } from "./events/message-handler";
import { WhatsAppFileHandler } from "./file-handler";
import { WhatsAppInteractionRenderer } from "./interactions";
import { WhatsAppResponseRenderer } from "./response-renderer";
import { jidToE164 } from "./types";

const logger = createLogger("whatsapp-platform");

export interface WhatsAppPlatformConfig {
  whatsapp: WhatsAppConfig;
}

export interface AgentOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutMinutes?: number;
}

/**
 * WhatsApp platform adapter.
 * Handles all WhatsApp-specific functionality using Baileys.
 */
export class WhatsAppPlatform implements PlatformAdapter {
  readonly name = "whatsapp";

  private client!: BaileysClient;
  private services!: CoreServices;
  private messageHandler?: WhatsAppMessageHandler;
  private responseRenderer?: WhatsAppResponseRenderer;
  private interactionRenderer?: WhatsAppInteractionRenderer;
  private authAdapter?: WhatsAppAuthAdapter;
  private fileHandler?: WhatsAppFileHandler;

  constructor(
    private readonly config: WhatsAppPlatformConfig,
    private readonly agentOptions: AgentOptions,
    private readonly sessionTimeoutMinutes: number
  ) {}

  /**
   * Initialize with core services.
   */
  async initialize(services: CoreServices): Promise<void> {
    logger.info("Initializing WhatsApp platform...");
    this.services = services;

    // Create Baileys client
    this.client = new BaileysClient(this.config.whatsapp);

    // Create file handler for media
    this.fileHandler = new WhatsAppFileHandler(this.client);

    // Create message handler
    this.messageHandler = new WhatsAppMessageHandler(
      this.client,
      this.config.whatsapp,
      services.getQueueProducer(),
      services.getSessionManager(),
      this.agentOptions
    );

    // Connect file handler to message handler
    this.messageHandler.setFileHandler(this.fileHandler);

    // Create response renderer for unified thread consumer
    this.responseRenderer = new WhatsAppResponseRenderer(
      this.client,
      this.config.whatsapp
    );

    // Wire up conversation history tracking
    this.responseRenderer.setStoreOutgoingCallback((chatJid, text) => {
      this.messageHandler?.storeOutgoingMessage(chatJid, text);
    });

    // Create interaction renderer
    this.interactionRenderer = new WhatsAppInteractionRenderer(
      this.client,
      services.getInteractionService(),
      this.config.whatsapp
    );

    // Register beforeCreate hook to stop streams before interaction
    const interactionService = services.getInteractionService();
    interactionService.setBeforeCreateHook(
      async (userId: string, threadId: string) => {
        logger.info({ userId, threadId }, "Stopping stream before interaction");
        // WhatsApp doesn't have streaming, so this is a no-op
      }
    );

    // Register interaction button handler
    this.interactionRenderer.registerButtonHandler();

    // Create and register auth adapter
    const publicGatewayUrl = services.getPublicGatewayUrl();
    this.authAdapter = new WhatsAppAuthAdapter(this.client, publicGatewayUrl);
    platformAuthRegistry.register("whatsapp", this.authAdapter);

    // Connect auth adapter to message handler for auth response handling
    if (this.messageHandler) {
      this.messageHandler.setAuthAdapter(this.authAdapter);
    }

    logger.info("WhatsApp auth adapter registered");

    // Wire up channel binding service for agent routing
    const channelBindingService = services.getChannelBindingService();
    if (channelBindingService && this.messageHandler) {
      this.messageHandler.setChannelBindingService(channelBindingService);
      logger.info(
        "✅ Channel binding service wired to WhatsApp message handler"
      );
    }

    // Wire up agent settings store for applying agent configuration
    const agentSettingsStore = services.getAgentSettingsStore();
    if (agentSettingsStore && this.messageHandler) {
      this.messageHandler.setAgentSettingsStore(agentSettingsStore);
      logger.info("✅ Agent settings store wired to WhatsApp message handler");
    }

    logger.info("WhatsApp platform initialized");
  }

  /**
   * Get the auth adapter for handling auth responses.
   */
  getAuthAdapter(): WhatsAppAuthAdapter | undefined {
    return this.authAdapter;
  }

  /**
   * Get the file handler for media operations.
   */
  getFileHandler(): IFileHandler | undefined {
    return this.fileHandler;
  }

  /**
   * Start the platform (connect to WhatsApp).
   */
  async start(): Promise<void> {
    logger.info("Starting WhatsApp platform...");

    // Setup message handler BEFORE connecting (to catch early messages)
    if (this.messageHandler) {
      this.messageHandler.start();
    }

    // Connect to WhatsApp
    await this.client.connect();

    logger.info("WhatsApp platform started");
  }

  /**
   * Stop the platform gracefully.
   */
  async stop(): Promise<void> {
    logger.info("Stopping WhatsApp platform...");

    // Stop message handler
    if (this.messageHandler) {
      this.messageHandler.stop();
    }

    // Disconnect from WhatsApp
    await this.client.disconnect();

    logger.info("WhatsApp platform stopped");
  }

  /**
   * Check if platform is healthy.
   */
  isHealthy(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /**
   * Get the response renderer for unified thread consumer.
   */
  getResponseRenderer(): ResponseRenderer | undefined {
    return this.responseRenderer;
  }

  /**
   * Build platform-specific deployment metadata.
   */
  buildDeploymentMetadata(
    threadId: string,
    channelId: string,
    platformMetadata: Record<string, any>
  ): Record<string, string> {
    const jid = platformMetadata?.jid || channelId;
    const e164 = jidToE164(jid) || jid;

    return {
      chat_id: jid,
      phone_number: e164,
      thread_id: threadId,
      is_group: String(platformMetadata?.isGroup || false),
    };
  }

  /**
   * Render a blocking user interaction.
   */
  async renderInteraction(interaction: UserInteraction): Promise<void> {
    if (this.interactionRenderer) {
      await this.interactionRenderer.renderInteraction(interaction);
    }
  }

  /**
   * Render non-blocking suggestions.
   * WhatsApp doesn't have native suggested prompts, so we send as regular message.
   */
  async renderSuggestion(suggestion: UserSuggestion): Promise<void> {
    if (this.interactionRenderer) {
      await this.interactionRenderer.renderSuggestion(suggestion);
    }
  }

  /**
   * Set thread status indicator.
   * WhatsApp uses typing indicator instead.
   */
  async setThreadStatus(
    channelId: string,
    _threadId: string, // Not used for WhatsApp
    status: string | null
  ): Promise<void> {
    if (status && this.client) {
      // Show typing indicator
      await this.client.sendTyping(
        channelId,
        this.config.whatsapp.typingTimeout
      );
    }
    // Clear status is a no-op - typing auto-expires
  }

  /**
   * Check if token matches platform credentials.
   * WhatsApp doesn't use tokens in the same way.
   */
  isOwnBotToken(_token: string): boolean {
    // We don't have a simple token to compare
    return false;
  }

  /**
   * Send a message via WhatsApp for testing/automation.
   * If sending to self (self-chat mode), queues message directly to worker.
   */
  async sendMessage(
    _token: string,
    message: string,
    options: {
      agentId: string;
      channelId: string;
      threadId: string;
      teamId: string;
      files?: Array<{ buffer: Buffer; filename: string }>;
    }
  ): Promise<{
    messageId: string;
    eventsUrl?: string;
    queued?: boolean;
  }> {
    if (!this.client?.isConnected()) {
      throw new Error("WhatsApp not connected");
    }

    // Replace @me with nothing (WhatsApp doesn't have bot mentions)
    const cleanMessage = message.replace(/@me\s*/g, "").trim();

    // Check if this is a self-chat message (sending to bot's own number)
    const selfE164 = this.client.getSelfE164();

    // Handle special "self" channel value - resolve to bot's actual number
    const channel = options.channelId;
    const resolvedChannel =
      channel.toLowerCase() === "self" && selfE164 ? selfE164 : channel;
    // Strip WhatsApp JID suffix (@s.whatsapp.net) if present for normalization
    const channelWithoutJid = resolvedChannel.replace(
      /@s\.whatsapp\.net$/i,
      ""
    );
    const normalizedChannel = channelWithoutJid.startsWith("+")
      ? channelWithoutJid
      : `+${channelWithoutJid}`;
    const isSelfMessage =
      this.config.whatsapp.selfChatEnabled && normalizedChannel === selfE164;

    // Send the actual WhatsApp message
    const result = await this.client.sendMessage(resolvedChannel, {
      text: cleanMessage,
    });

    // If self-chat, queue the message directly to bypass event handler filter
    if (isSelfMessage) {
      const queueProducer = this.services.getQueueProducer();
      const messageId = result.messageId;

      // For self-chat, use the phone number as userId for proper space resolution
      // This ensures credentials are looked up correctly
      const phoneUserId = selfE164 || normalizedChannel;

      // Import resolveSpace for proper agentId
      const { resolveSpace } = await import("../spaces");
      const space = resolveSpace({
        platform: "whatsapp",
        userId: phoneUserId,
        channelId: phoneUserId,
        isGroup: false,
      });

      const payload = {
        userId: phoneUserId,
        threadId: space.agentId, // Use resolved space as thread identifier
        messageId,
        channelId: resolvedChannel,
        teamId: "whatsapp",
        agentId: space.agentId, // agentId is the isolation boundary
        botId: selfE164 || "whatsapp-bot",
        platform: "whatsapp",
        messageText: cleanMessage,
        platformMetadata: {
          remoteJid: `${resolvedChannel.replace("+", "")}@s.whatsapp.net`,
          isSelfChat: true,
          isFromMe: false, // Pretend it's from user for processing
        },
        agentOptions: {
          ...this.agentOptions,
          timeoutMinutes: this.sessionTimeoutMinutes.toString(),
        },
      };

      await queueProducer.enqueueMessage(payload);
      logger.info(
        `Queued self-chat message ${messageId} to worker queue (space: ${space.agentId})`
      );

      return {
        messageId,
        queued: true,
      };
    }

    return {
      messageId: result.messageId,
    };
  }

  /**
   * Check if channel ID represents a group vs DM.
   * WhatsApp group JIDs end with @g.us
   */
  isGroupChannel(channelId: string): boolean {
    return channelId.endsWith("@g.us");
  }

  /**
   * Get display info for WhatsApp platform.
   */
  getDisplayInfo(): { name: string; icon: string; logoUrl?: string } {
    return {
      name: "WhatsApp",
      icon: `<svg viewBox="0 0 24 24" fill="#25D366" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`,
    };
  }

  /**
   * Extract routing info from WhatsApp-specific request body.
   */
  extractRoutingInfo(body: Record<string, unknown>): {
    channelId: string;
    threadId: string;
    teamId?: string;
  } | null {
    const whatsapp = body.whatsapp as { chat?: string } | undefined;
    if (!whatsapp?.chat) return null;

    return {
      channelId: whatsapp.chat,
      threadId: "",
    };
  }
}

/**
 * WhatsApp platform factory for declarative registration.
 */
const whatsappFactory: PlatformFactory = {
  name: "whatsapp",

  isEnabled(configs: PlatformConfigs): boolean {
    return configs.whatsapp?.enabled === true;
  },

  create(
    configs: PlatformConfigs,
    agentOptions: FactoryAgentOptions,
    sessionTimeoutMinutes: number
  ) {
    const platformConfig: WhatsAppPlatformConfig = {
      whatsapp: configs.whatsapp,
    };
    return new WhatsAppPlatform(
      platformConfig,
      agentOptions,
      sessionTimeoutMinutes
    );
  },
};

// Register factory on module load
platformFactoryRegistry.register(whatsappFactory);
