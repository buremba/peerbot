#!/usr/bin/env bun

import {
  createLogger,
  type InstructionProvider,
  moduleRegistry,
  type UserInteraction,
  type UserSuggestion,
} from "@peerbot/core";
import { App, type AppOptions, ExpressReceiver, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { NextFunction, Request, Response } from "express";
import type { MessagePayload } from "../infrastructure/queue/queue-producer";
import type { CoreServices, PlatformAdapter } from "../platform";
import {
  type AgentOptions as FactoryAgentOptions,
  type PlatformConfigs,
  type PlatformFactory,
  platformFactoryRegistry,
} from "../platform/platform-factory";
import type { ResponseRenderer } from "../platform/response-renderer";
import { resolveSpace } from "../spaces";
import type { AgentOptions, SlackPlatformConfig } from "./config";
import { SlackEventHandlers } from "./event-router";
import { SlackFileHandler } from "./file-handler";
import { SocketHealthMonitor } from "./health/socket-health-monitor";
import { SlackInstructionProvider } from "./instructions/provider";
import { SlackInteractionRenderer } from "./interactions";
import { SlackResponseRenderer } from "./response-renderer";

const logger = createLogger("slack-platform");

/**
 * Slack platform adapter
 * Handles all Slack-specific functionality
 * Uses core services provided by Gateway
 */
export class SlackPlatform implements PlatformAdapter {
  readonly name = "slack";

  private app!: App;
  private receiver?: ExpressReceiver;
  private responseRenderer?: SlackResponseRenderer;
  private socketHealthMonitor?: SocketHealthMonitor;
  private services!: CoreServices;
  private fileHandler?: SlackFileHandler;
  private interactionRenderer?: SlackInteractionRenderer;
  private eventHandlers?: SlackEventHandlers;

  constructor(
    private readonly config: SlackPlatformConfig,
    private readonly agentOptions: AgentOptions,
    private readonly sessionTimeoutMinutes: number
  ) {
    // Initialize Slack app (doesn't connect yet)
    this.initializeSlackApp();
  }

  /**
   * Initialize Slack app (HTTP or Socket Mode)
   */
  private initializeSlackApp(): void {
    if (this.config.slack.socketMode === false) {
      // HTTP mode
      this.receiver = new ExpressReceiver({
        signingSecret: this.config.slack.signingSecret!,
        endpoints: { events: "/slack/events" },
        processBeforeResponse: true,
        logLevel: LogLevel.DEBUG,
      });

      // URL verification challenge handler
      this.receiver.router.use("/slack/events", (req, res, next) => {
        if (req.body && req.body.type === "url_verification") {
          logger.info("Handling Slack URL verification challenge");
          return res.status(200).json({ challenge: req.body.challenge });
        }
        next();
      });

      this.app = new App({
        token: this.config.slack.token,
        receiver: this.receiver,
        logLevel: this.config.logLevel || LogLevel.DEBUG,
        ignoreSelf: false,
      });

      logger.info("Slack app initialized in HTTP mode");
    } else {
      // Socket mode
      const appConfig: AppOptions = {
        signingSecret: this.config.slack.signingSecret,
        socketMode: true,
        appToken: this.config.slack.appToken,
        port: this.config.slack.port || 3000,
        logLevel: this.config.logLevel || LogLevel.INFO,
        ignoreSelf: false,
        processBeforeResponse: true,
        token: this.config.slack.token,
      };

      if (!this.config.slack.token) {
        throw new Error("SLACK_BOT_TOKEN is required");
      }

      this.app = new App(appConfig);
      logger.info("Slack app initialized in Socket mode");
    }

    this.setupErrorHandling();
    this.setupGracefulShutdown();

    // Add global middleware to log events
    this.app.use(async ({ payload, next }) => {
      const payloadWithEvent = payload as {
        event?: { type?: string; subtype?: string };
      };
      const event = payloadWithEvent.event || payload;
      const eventWithTypes = event as { type?: string; subtype?: string };
      logger.debug(
        `[Slack Event] Type: ${eventWithTypes?.type}, Subtype: ${eventWithTypes?.subtype}`
      );
      await next();
    });
  }

  /**
   * Initialize with core services
   */
  async initialize(services: CoreServices): Promise<void> {
    logger.info("Initializing Slack platform...");
    this.services = services;

    // Get bot info
    await this.initializeBotInfo();

    // Create file handler
    this.fileHandler = new SlackFileHandler(this.app.client);

    // Create response renderer for unified thread consumer
    this.responseRenderer = new SlackResponseRenderer(
      services.getQueue(),
      this.app.client,
      moduleRegistry
    );

    // Create interaction renderer
    const interactionService = services.getInteractionService();
    this.interactionRenderer = new SlackInteractionRenderer(
      this.app.client,
      interactionService
    );
    logger.info("✅ Slack interaction renderer initialized");

    // Register beforeCreate hook to stop streams BEFORE interaction is created
    // This ensures interaction message appears after stream stops, not mixed in
    interactionService.setBeforeCreateHook(
      async (userId: string, threadId: string) => {
        logger.info(
          `Stopping stream for thread ${threadId} before creating interaction`
        );
        await this.responseRenderer?.stopStreamForThread(userId, threadId);
      }
    );
    logger.info("✅ Stream stop hook registered for interactions");

    // Register interaction button handlers
    const { registerInteractionHandlers } = await import("./interactions");
    registerInteractionHandlers(
      this.app,
      interactionService,
      this.interactionRenderer
    );
    logger.info("✅ Interaction button handlers registered");

    // Initialize event handlers
    this.eventHandlers = new SlackEventHandlers(
      this.app,
      services.getQueueProducer(),
      {
        slack: this.config.slack,
        agentOptions: this.agentOptions,
        sessionTimeoutMinutes: this.sessionTimeoutMinutes,
      },
      moduleRegistry,
      services.getSessionManager(),
      interactionService,
      this // Pass platform instance for auth status rendering
    );

    // Wire up channel binding service for agent routing
    const channelBindingService = services.getChannelBindingService();
    if (channelBindingService) {
      this.eventHandlers.setChannelBindingService(channelBindingService);
      logger.info("✅ Channel binding service wired to Slack event handlers");
    }

    // Wire up agent settings store for applying agent configuration
    const agentSettingsStore = services.getAgentSettingsStore();
    if (agentSettingsStore) {
      this.eventHandlers.setAgentSettingsStore(agentSettingsStore);
      logger.info("✅ Agent settings store wired to Slack event handlers");
    }

    logger.info("✅ Slack platform initialized");
  }

  /**
   * Start Slack platform
   */
  async start(): Promise<void> {
    logger.info("Starting Slack platform...");

    // Start Slack app
    if (this.config.slack.socketMode === false) {
      await this.initializeHttpMode();
    } else {
      await this.initializeSocketMode();
    }

    const mode = this.config.slack.socketMode
      ? "Socket Mode"
      : `HTTP on port ${this.config.slack.port}`;
    logger.info(`✅ Slack platform running in ${mode}`);
  }

  /**
   * Stop Slack platform
   */
  async stop(): Promise<void> {
    logger.info("Stopping Slack platform...");

    // Stop health monitor
    if (this.socketHealthMonitor) {
      this.socketHealthMonitor.stop();
    }

    // Stop Slack app
    await this.app.stop();

    logger.info("✅ Slack platform stopped");
  }

  /**
   * Check health
   */
  isHealthy(): boolean {
    // Check if app is running and queue is healthy
    return this.services?.getQueueProducer().isHealthy() ?? false;
  }

  /**
   * Provide Slack-specific instruction provider
   */
  getInstructionProvider(): InstructionProvider {
    return new SlackInstructionProvider();
  }

  /**
   * Get the response renderer for unified thread consumer
   */
  getResponseRenderer(): ResponseRenderer | undefined {
    return this.responseRenderer;
  }

  /**
   * Get file handler for this platform
   */
  getFileHandler(): SlackFileHandler | undefined {
    return this.fileHandler;
  }

  /**
   * Build Slack-specific deployment metadata
   * Creates Slack thread URLs and team metadata for deployments
   */
  buildDeploymentMetadata(
    threadId: string,
    channelId: string,
    platformMetadata: Record<string, any>
  ): Record<string, string> {
    const metadata: Record<string, string> = {};

    // Support both camelCase (from events) and snake_case (from worker)
    const teamId = platformMetadata.teamId || platformMetadata.team_id;
    if (teamId) {
      metadata.thread_url = `https://app.slack.com/client/${teamId}/${channelId}/thread/${threadId}`;
      metadata.team_id = teamId;
    }

    return metadata;
  }

  /**
   * Render blocking interaction (ephemeral message)
   */
  async renderInteraction(interaction: UserInteraction): Promise<void> {
    if (this.interactionRenderer) {
      await this.interactionRenderer.renderInteraction(interaction);
    }
  }

  /**
   * Render non-blocking suggestions
   */
  async renderSuggestion(suggestion: UserSuggestion): Promise<void> {
    if (this.interactionRenderer) {
      await this.interactionRenderer.renderSuggestion(suggestion);
    }
  }

  /**
   * Set thread status (or clear if null)
   */
  async setThreadStatus(
    channelId: string,
    threadId: string,
    status: string | null
  ): Promise<void> {
    if (this.interactionRenderer) {
      await this.interactionRenderer.setThreadStatus(
        channelId,
        threadId,
        status
      );
    }
  }

  /**
   * Check if token matches this platform's configured bot token
   */
  isOwnBotToken(token: string): boolean {
    return token === this.config.slack.token;
  }

  /**
   * Send a message via Slack
   * Supports channel name resolution, multiple file uploads, and @me placeholder
   */
  async sendMessage(
    token: string,
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
    const client = new WebClient(token);

    // Get bot user ID and team ID (single auth.test call)
    let botUserId: string | undefined;
    let resolvedTeamId: string | undefined = options.teamId;
    try {
      const authResponse = await client.auth.test();
      if (authResponse.ok) {
        botUserId = authResponse.user_id;
        // Use resolved team ID if not provided
        if (!resolvedTeamId || resolvedTeamId === "unknown") {
          resolvedTeamId = authResponse.team_id;
        }
      }
    } catch (error) {
      logger.warn("Could not get bot info:", error);
    }

    // Replace @me placeholder with actual bot mention
    let processedMessage = message;
    if (botUserId && message.includes("@me")) {
      processedMessage = message.replace(/@me\b/g, `<@${botUserId}>`);
    }

    // Resolve channel name to ID if needed
    let channelId = options.channelId;
    if (!channelId.match(/^[CDG][A-Z0-9]+$/)) {
      logger.info(`Resolving channel name "${channelId}" to ID...`);
      channelId = await this.resolveChannelName(client, channelId);
      logger.info(
        `Resolved channel "${options.channelId}" to ID: ${channelId}`
      );
    }

    // Detect self-messaging: any message sent with bot's own token needs manual queueing
    // because Slack will mark it as from the bot user and our event handler filters those out
    const isSelfMessage = this.isOwnBotToken(token);

    // Thread ID for Slack (use provided or will be set to message ts)
    const slackThreadId =
      options.threadId !== options.agentId ? options.threadId : undefined;

    // Handle file uploads
    if (options.files && options.files.length > 0) {
      const result = await this.sendMessageWithFiles(
        client,
        channelId,
        processedMessage,
        options.files,
        slackThreadId,
        resolvedTeamId,
        isSelfMessage
      );
      return {
        messageId: result.messageId,
        eventsUrl: result.threadUrl,
        queued: result.queued,
      };
    }

    // Send regular message
    const response = await client.chat.postMessage({
      channel: channelId,
      text: processedMessage,
      thread_ts: slackThreadId,
    });

    if (!response.ok || !response.ts) {
      throw new Error(`Failed to send message: ${response.error || "unknown"}`);
    }

    const messageId = response.ts;
    const threadId = slackThreadId || messageId;

    // Build thread URL if we have team ID
    let eventsUrl: string | undefined;
    if (resolvedTeamId) {
      eventsUrl = `https://app.slack.com/client/${resolvedTeamId}/${channelId}/thread/${threadId}`;
    }

    // If self-messaging, manually queue since Slack won't send webhook
    let queued = false;
    if (isSelfMessage && botUserId) {
      logger.info(
        `Self-messaging detected - manually queuing message ${messageId}`
      );
      await this.queueSelfMessage(
        channelId,
        messageId,
        threadId,
        processedMessage,
        botUserId,
        resolvedTeamId
      );
      queued = true;
    }

    return {
      messageId,
      eventsUrl,
      queued,
    };
  }

  /**
   * Resolve channel name to channel ID
   */
  private async resolveChannelName(
    client: WebClient,
    channelName: string
  ): Promise<string> {
    // Remove # prefix if present
    const cleanName = channelName.replace(/^#/, "");

    let cursor: string | undefined;
    do {
      const response = await client.conversations.list({
        exclude_archived: true,
        limit: 1000,
        cursor,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to list channels: ${response.error || "unknown"}`
        );
      }

      const channels = response.channels || [];
      const match = channels.find((ch: any) => ch.name === cleanName);

      if (match?.id) {
        return match.id;
      }

      cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    throw new Error(`Channel "${channelName}" not found`);
  }

  /**
   * Send message with multiple file uploads (Slack v2 file upload)
   */
  private async sendMessageWithFiles(
    client: WebClient,
    channelId: string,
    message: string,
    files: Array<{ buffer: Buffer; filename: string }>,
    threadId?: string,
    teamId?: string,
    isSelfMessage?: boolean
  ): Promise<{
    channel: string;
    messageId: string;
    threadId: string;
    threadUrl?: string;
    queued?: boolean;
  }> {
    // Step 1: Upload all files and get their IDs
    const fileIds: Array<{ id: string; title: string }> = [];

    for (const file of files) {
      // Get upload URL for this file
      const uploadUrlResponse = (await client.apiCall(
        "files.getUploadURLExternal",
        {
          filename: file.filename,
          length: file.buffer.length,
        }
      )) as {
        ok?: boolean;
        upload_url?: string;
        file_id?: string;
        error?: string;
      };

      if (
        !uploadUrlResponse.ok ||
        !uploadUrlResponse.upload_url ||
        !uploadUrlResponse.file_id
      ) {
        throw new Error(
          `Failed to get upload URL for ${file.filename}: ${uploadUrlResponse.error || "unknown"}`
        );
      }

      // Upload file to URL
      const uploadResponse = await fetch(uploadUrlResponse.upload_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": file.buffer.length.toString(),
        },
        body: file.buffer,
      });

      if (!uploadResponse.ok) {
        throw new Error(
          `File upload failed for ${file.filename}: ${uploadResponse.status} ${await uploadResponse.text()}`
        );
      }

      fileIds.push({
        id: uploadUrlResponse.file_id,
        title: file.filename,
      });
    }

    // Step 2: Complete upload and share all files to channel
    const completeBody: any = {
      files: fileIds,
      channel_id: channelId,
      initial_comment: message,
    };

    if (threadId) {
      completeBody.thread_ts = threadId;
    }

    const completeResponse = (await client.apiCall(
      "files.completeUploadExternal",
      completeBody
    )) as {
      ok?: boolean;
      files?: any[];
      error?: string;
    };

    if (!completeResponse.ok) {
      throw new Error(
        `Failed to complete upload: ${completeResponse.error || "unknown"}`
      );
    }

    // Step 3: Fetch message timestamp from history
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const historyResponse = await client.conversations.history({
      channel: channelId,
      limit: 1,
    });

    if (!historyResponse.ok || !historyResponse.messages?.[0]?.ts) {
      throw new Error("Could not fetch message timestamp after file upload");
    }

    const messageId = historyResponse.messages[0].ts;
    const finalThreadId = threadId || messageId;

    // Build thread URL if we have team ID
    let threadUrl: string | undefined;
    if (teamId) {
      threadUrl = `https://app.slack.com/client/${teamId}/${channelId}/thread/${finalThreadId}`;
    }

    // If self-messaging, manually queue since Slack won't send webhook
    let queued = false;
    if (isSelfMessage) {
      logger.info(
        `Self-messaging with files - manually queuing message ${messageId}`
      );
      const botUserId = await this.getBotUserId(client);
      if (botUserId) {
        await this.queueSelfMessage(
          channelId,
          messageId,
          finalThreadId,
          message,
          botUserId,
          teamId
        );
        queued = true;
      }
    }

    return {
      channel: channelId,
      messageId,
      threadId: finalThreadId,
      threadUrl,
      queued,
    };
  }

  /**
   * Get bot user ID from client
   */
  private async getBotUserId(client: WebClient): Promise<string | undefined> {
    try {
      const authResponse = await client.auth.test();
      return authResponse.ok ? authResponse.user_id : undefined;
    } catch (error) {
      logger.warn("Could not get bot user ID:", error);
      return undefined;
    }
  }

  /**
   * Queue self-generated message directly (bypasses Slack webhook filtering)
   * Uses TEST_USER_ID env var for testing, or falls back to the first allowed user
   */
  private async queueSelfMessage(
    channelId: string,
    messageId: string,
    threadId: string,
    message: string,
    botUserId: string,
    teamId?: string
  ): Promise<void> {
    const queueProducer = this.services.getQueueProducer();

    // Use TEST_USER_ID for testing, or fall back to bot's user
    const testUserId = process.env.TEST_USER_ID || botUserId;

    // Resolve agentId for multi-tenant isolation
    const isDirectMessage = channelId.startsWith("D");
    const { agentId } = resolveSpace({
      platform: "slack",
      userId: testUserId,
      channelId,
      isGroup: !isDirectMessage,
    });

    // Build payload matching MessagePayload structure
    const payload: MessagePayload = {
      platform: "slack",
      userId: testUserId,
      botId: this.config.slack.botId || "",
      threadId,
      teamId: teamId || "",
      agentId,
      messageId,
      messageText: message,
      channelId,
      platformMetadata: {
        teamId: teamId || "",
        userDisplayName: "Test User",
        responseChannel: channelId,
        responseId: messageId,
        originalMessageId: messageId,
        files: [],
      },
      agentOptions: {
        ...this.agentOptions,
        timeoutMinutes: this.sessionTimeoutMinutes.toString(),
      },
    };

    await queueProducer.enqueueMessage(payload);
    logger.info(
      `Queued self-generated message ${messageId} (as user ${testUserId}) to messages queue`
    );
  }

  /**
   * Initialize bot info (bot user ID and bot ID)
   */
  private async initializeBotInfo(): Promise<void> {
    if (!this.config.slack.botUserId || !this.config.slack.botId) {
      logger.info("Bot IDs not configured, calling auth.test...");

      const response = await fetch(`${this.config.slack.apiUrl}/auth.test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.slack.token}`,
          "Content-Type": "application/json",
        },
      });

      const authResult = (await response.json()) as {
        ok: boolean;
        user_id?: string;
        bot_id?: string;
        error?: string;
      };

      if (!authResult.ok || !authResult.user_id || !authResult.bot_id) {
        throw new Error(
          `Auth test failed: ${authResult.error || "Unknown error"}`
        );
      }

      this.config.slack.botUserId = authResult.user_id;
      this.config.slack.botId = authResult.bot_id;

      logger.info(
        `Bot initialized - User ID: ${authResult.user_id}, Bot ID: ${authResult.bot_id}`
      );
    } else {
      logger.info(
        `Using configured bot IDs - User ID: ${this.config.slack.botUserId}, Bot ID: ${this.config.slack.botId}`
      );
    }
  }

  /**
   * Initialize HTTP Mode
   */
  private async initializeHttpMode(): Promise<void> {
    await this.app.start(this.config.slack.port || 3000);

    if (!this.receiver) {
      throw new Error("Receiver not initialized for HTTP mode");
    }
    const expressApp = this.receiver.app;

    // Add request logging middleware
    expressApp.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });

    logger.info(
      `✅ Slack HTTP mode started on port ${this.config.slack.port || 3000}`
    );
  }

  /**
   * Initialize Socket Mode
   */
  private async initializeSocketMode(): Promise<void> {
    const receiver = (this.app as any).receiver;
    const socketModeClient = receiver?.client as
      | {
          on: (event: string, handler: (...args: unknown[]) => void) => void;
          removeListener: (
            event: string,
            handler: (...args: unknown[]) => void
          ) => void;
          once: (event: string, handler: (...args: unknown[]) => void) => void;
          isConnected?: () => boolean;
          stateMachine?: { getCurrentState?: () => string };
        }
      | undefined;

    if (!socketModeClient) {
      logger.warn("No Socket Mode client found");
      return;
    }

    // Circuit breaker for reconnection loops
    let connectionCount = 0;
    let lastConnectionTime = Date.now();
    const RECONNECTION_THRESHOLD = 5;
    const RECONNECTION_WINDOW_MS = 30000;

    const checkReconnectionLoop = () => {
      const now = Date.now();
      const timeSinceLastConnection = now - lastConnectionTime;

      if (timeSinceLastConnection > RECONNECTION_WINDOW_MS) {
        connectionCount = 0;
      }

      connectionCount++;
      lastConnectionTime = now;

      if (
        connectionCount >= RECONNECTION_THRESHOLD &&
        timeSinceLastConnection < RECONNECTION_WINDOW_MS
      ) {
        logger.error(
          `❌ FATAL: Detected reconnection loop (${connectionCount} reconnections in ${timeSinceLastConnection}ms)`
        );
        process.exit(1);
      }
    };

    // Initialize health monitor
    this.socketHealthMonitor = new SocketHealthMonitor(this.config.health);

    socketModeClient.on("slack_event", (...args: unknown[]) => {
      const event = args[0] as { type?: string };
      logger.debug("Socket Mode event:", event.type);
      this.socketHealthMonitor?.recordSocketEvent();
    });

    socketModeClient.on("disconnect", () => {
      logger.warn("Socket Mode disconnected, will auto-reconnect");
    });

    socketModeClient.on("error", (error: unknown) => {
      logger.error("Socket Mode error:", error as Error);
    });

    socketModeClient.on("ready", () => {
      logger.info("Socket Mode client ready");
      this.socketHealthMonitor?.recordSocketEvent();
    });

    socketModeClient.on("connecting", () => {
      logger.info("Socket Mode connecting...");
      checkReconnectionLoop();
    });

    socketModeClient.on("connected", () => {
      logger.info("Socket Mode connected!");
      this.socketHealthMonitor?.recordSocketEvent();

      // Reset counter on stable connection
      setTimeout(() => {
        connectionCount = 0;
        logger.debug("Connection stable - reset reconnection counter");
      }, 5000);

      // Start health monitoring
      if (this.socketHealthMonitor && this.services.getWorkerGateway()) {
        this.socketHealthMonitor.start(
          () =>
            this.services.getWorkerGateway()?.getActiveConnections().length || 0
        );
        logger.info("✅ Socket health monitoring enabled");
      }
    });

    // Start Socket Mode app
    this.app.start();

    // Wait for connection
    const connectionPromise = new Promise<void>((resolve, reject) => {
      const connectedHandler = () => {
        logger.info("✅ Socket Mode connection established!");
        clearTimeout(timeoutId);
        resolve();
      };

      const timeoutId = setTimeout(() => {
        socketModeClient.removeListener("connected", connectedHandler);
        reject(new Error("Socket Mode connection timeout"));
      }, 10000);

      if (
        socketModeClient.isConnected?.() ||
        socketModeClient.stateMachine?.getCurrentState?.() === "connected"
      ) {
        connectedHandler();
      } else {
        socketModeClient.once("connected", connectedHandler);
      }
    });

    await connectionPromise.catch((error) => {
      logger.warn("Socket Mode connection warning:", error.message);
    });

    // Stabilize
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  /**
   * Setup error handling
   */
  private setupErrorHandling(): void {
    this.app.error(async (error: Error) => {
      logger.error("Slack app error:", error);
    });

    process.on("unhandledRejection", (reason) => {
      const reasonStr = String(reason);
      if (
        reasonStr.includes("server explicit disconnect") ||
        reasonStr.includes("Unhandled event")
      ) {
        logger.debug(
          "Socket Mode connection event (expected):",
          reasonStr.substring(0, 100)
        );
        return;
      }
      logger.error("Unhandled Rejection:", reason);
    });

    process.on("uncaughtException", (error) => {
      const errorStr = error?.toString() || "";
      if (
        errorStr.includes("server explicit disconnect") ||
        errorStr.includes("Unhandled event")
      ) {
        logger.debug(
          "Socket Mode exception (expected):",
          errorStr.substring(0, 100)
        );
        return;
      }
      logger.error("Uncaught Exception:", error);
      process.exit(1);
    });
  }

  /**
   * Render authentication status for OAuth providers
   * Implements platform-specific UI rendering for auth status
   */
  async renderAuthStatus(
    userId: string,
    providers: Array<{
      id: string;
      name: string;
      isAuthenticated: boolean;
      loginUrl?: string;
      logoutUrl?: string;
      metadata?: Record<string, any>;
    }>
  ): Promise<void> {
    logger.info(
      `Rendering auth status for user ${userId} with ${providers.length} providers`
    );

    const blocks: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Authentication Status*" },
      },
    ];

    for (const provider of providers) {
      const statusIcon = provider.isAuthenticated ? "🟢" : "🔴";
      const statusText = provider.isAuthenticated
        ? "Connected"
        : "Not Connected";

      const sectionBlock: any = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${statusIcon} *${provider.name}* - ${statusText}`,
        },
      };

      // Add action button if login/logout URL is available
      if (provider.loginUrl && !provider.isAuthenticated) {
        sectionBlock.accessory = {
          type: "button",
          text: { type: "plain_text", text: "Login" },
          url: provider.loginUrl,
          style: "primary",
        };
      }

      blocks.push(sectionBlock);
    }

    // Publish to user's app home
    await this.app.client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        blocks,
      },
    });

    logger.info(`Successfully rendered auth status for user ${userId}`);
  }

  /**
   * Check if channel ID represents a group/channel vs DM.
   * Slack channel IDs: C = public channel, G = private channel, D = DM
   */
  isGroupChannel(channelId: string): boolean {
    return channelId.startsWith("C") || channelId.startsWith("G");
  }

  /**
   * Get display info for Slack platform.
   */
  getDisplayInfo(): { name: string; icon: string; logoUrl?: string } {
    return {
      name: "Slack",
      icon: `<svg viewBox="0 0 124 124" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M26.4 78.6c0 7.1-5.8 12.9-12.9 12.9S.6 85.7.6 78.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V78.6z" fill="#E01E5A"/><path d="M45.8 26.4c-7.1 0-12.9-5.8-12.9-12.9S38.7.6 45.8.6s12.9 5.8 12.9 12.9v12.9H45.8zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H13.5C6.4 58.7.6 52.9.6 45.8s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M97.6 45.8c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97.6V45.8zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V13.5c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M78.2 97.6c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97.6h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H78.2z" fill="#ECB22E"/></svg>`,
    };
  }

  /**
   * Extract routing info from Slack-specific request body.
   */
  extractRoutingInfo(body: Record<string, unknown>): {
    channelId: string;
    threadId: string;
    teamId?: string;
  } | null {
    const slack = body.slack as
      | { channel?: string; thread?: string; team?: string }
      | undefined;
    if (!slack?.channel) return null;

    return {
      channelId: slack.channel,
      threadId: slack.thread || "",
      teamId: slack.team,
    };
  }

  /**
   * Setup graceful shutdown
   */
  private setupGracefulShutdown(): void {
    const cleanup = async () => {
      logger.info("Graceful shutdown initiated...");
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
}

/**
 * Slack platform factory for declarative registration.
 */
const slackFactory: PlatformFactory = {
  name: "slack",

  isEnabled(configs: PlatformConfigs): boolean {
    return !!configs.slack?.token;
  },

  create(
    configs: PlatformConfigs,
    agentOptions: FactoryAgentOptions,
    sessionTimeoutMinutes: number
  ) {
    const platformConfig: SlackPlatformConfig = {
      slack: configs.slack,
      logLevel: configs.logLevel || configs.slack?.logLevel,
      health: configs.health || {
        checkIntervalMs: 30000,
        staleThresholdMs: 300000,
        protectActiveWorkers: true,
      },
    };
    return new SlackPlatform(
      platformConfig,
      agentOptions as AgentOptions,
      sessionTimeoutMinutes
    );
  },
};

// Register factory on module load
platformFactoryRegistry.register(slackFactory);
