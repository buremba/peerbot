#!/usr/bin/env bun

import type { IModuleRegistry } from "@peerbot/core";
import { createLogger } from "@peerbot/core";
import type { App } from "@slack/bolt";
import type {
  FileDeletedEvent,
  FileSharedEvent,
  GenericMessageEvent,
  View,
} from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type { QueueProducer } from "../infrastructure/queue";
import type { InteractionService } from "../interactions";
import type { PlatformAdapter } from "../platform";
import type { ISessionManager } from "../session";

const logger = createLogger("slack-events");

import type { MessageHandlerConfig } from "./config";
import { ActionHandler } from "./events/actions";
import { setupAssistantHandlers } from "./events/assistant";
import { handleBlockkitFormSubmission } from "./events/forms";
import { MessageHandler } from "./events/messages";
import { ShortcutCommandHandler } from "./events/shortcuts";
import { setupTeamJoinHandler } from "./events/welcome";
import type { SlackContext, SlackMessageEvent } from "./types";
import { isSelfGeneratedEvent } from "./utils";

/**
 * Queue-based Slack event handlers that route messages to appropriate queues
 * This is the main orchestrator that delegates to specialized handlers
 */
export class SlackEventHandlers {
  private messageHandler: MessageHandler;
  private actionHandler: ActionHandler;
  private shortcutCommandHandler: ShortcutCommandHandler;
  private sessionManager: ISessionManager;
  private config: MessageHandlerConfig;

  constructor(
    private app: App,
    queueProducer: QueueProducer,
    config: MessageHandlerConfig,
    private moduleRegistry: IModuleRegistry,
    sessionManager: ISessionManager,
    interactionService: InteractionService,
    platform?: PlatformAdapter
  ) {
    this.config = config;
    this.sessionManager = sessionManager;

    // Initialize specialized handlers
    this.messageHandler = new MessageHandler(
      queueProducer,
      config,
      this.sessionManager,
      app.client,
      interactionService
    );
    this.actionHandler = new ActionHandler(
      this.messageHandler,
      this.moduleRegistry,
      platform
    );
    this.shortcutCommandHandler = new ShortcutCommandHandler(app);

    // Setup all event handlers
    this.setupEventHandlers();
  }

  /**
   * Setup all Slack event handlers
   */
  private setupEventHandlers(): void {
    logger.info("Setting up Queue-based Slack event handlers...");

    // Setup message event handlers
    this.app.event("message", async ({ event }) => {
      const messageEvent = event as GenericMessageEvent;

      // Handle message edits
      if (messageEvent.subtype === "message_changed") {
        logger.debug("Message changed", {
          channel: messageEvent.channel,
          ts: messageEvent.ts,
          user: messageEvent.user,
        });
      }

      // Handle message deletions
      if (messageEvent.subtype === "message_deleted") {
        logger.debug("Message deleted", {
          channel: messageEvent.channel,
          ts: messageEvent.ts,
        });
      }
    });

    // Setup file event handlers
    this.app.event("file_shared", async ({ event }) => {
      const fileEvent = event as FileSharedEvent;
      logger.debug("File shared", {
        channel: fileEvent.channel_id,
        fileId: fileEvent.file_id,
        user: fileEvent.user_id,
      });
    });

    this.app.event("file_deleted", async ({ event }) => {
      const fileEvent = event as FileDeletedEvent;
      logger.debug("File deleted", {
        fileId: fileEvent.file_id,
      });
    });

    // Setup assistant thread event handlers
    this.app.event("assistant_thread_started", async ({ event, client }) => {
      const assistantEvent = event as {
        assistant_thread: {
          user_id: string;
          channel_id: string;
          thread_ts: string;
          context: any;
        };
      };
      logger.info("Assistant thread started", {
        user: assistantEvent.assistant_thread.user_id,
        channel: assistantEvent.assistant_thread.channel_id,
        threadTs: assistantEvent.assistant_thread.thread_ts,
      });

      // Send a welcome message when assistant thread starts
      try {
        await client.chat.postMessage({
          channel: assistantEvent.assistant_thread.channel_id,
          thread_ts: assistantEvent.assistant_thread.thread_ts,
          text: "👋 Hi! I'm Peerbot, your AI coding assistant. How can I help you today?",
        });
      } catch (error) {
        logger.error("Failed to send assistant thread welcome message:", error);
      }
    });

    this.app.event("assistant_thread_context_changed", async ({ event }) => {
      const contextEvent = event as {
        assistant_thread: {
          user_id: string;
          channel_id: string;
          thread_ts: string;
        };
      };
      logger.debug("Assistant thread context changed", {
        user: contextEvent.assistant_thread.user_id,
        channel: contextEvent.assistant_thread.channel_id,
        threadTs: contextEvent.assistant_thread.thread_ts,
      });
    });

    // Setup user event handlers
    this.app.event("team_join", async ({ event }) => {
      const teamJoinEvent = event as { user?: { id: string } };
      logger.debug("Team join", {
        user: teamJoinEvent.user?.id,
      });
    });

    this.app.event("presence_change", async ({ event }) => {
      const presenceEvent = event as unknown as {
        user: string;
        presence: string;
      };
      logger.debug("Presence change", {
        user: presenceEvent.user,
        presence: presenceEvent.presence,
      });
    });

    this.app.event("member_joined_channel", async ({ event, client }) => {
      const memberEvent = event as { user: string; channel: string };
      logger.debug("Member joined channel", {
        user: memberEvent.user,
        channel: memberEvent.channel,
      });

      try {
        // Skip if it's a bot joining
        if (memberEvent.user.startsWith("B")) {
          logger.info(`Skipping welcome for bot user: ${memberEvent.user}`);
          return;
        }

        // Check if it's the bot itself joining
        const authResult = await client.auth.test();
        if (memberEvent.user === authResult.user_id) {
          logger.info(`Skipping welcome for bot itself: ${memberEvent.user}`);
          return;
        }

        // Send welcome message
        await this.shortcutCommandHandler.sendContextAwareWelcome(
          memberEvent.user,
          memberEvent.channel,
          client as WebClient
        );
      } catch (error) {
        logger.error("Failed to send welcome message:", error);
      }
    });

    // Setup team join event handler for welcome messages
    setupTeamJoinHandler(
      this.app,
      (
        userId: string,
        channelId: string,
        client: WebClient,
        threadTs?: string
      ) =>
        this.shortcutCommandHandler.sendContextAwareWelcome(
          userId,
          channelId,
          client,
          threadTs
        )
    );

    // Setup shortcuts, slash commands, and view submissions
    this.shortcutCommandHandler.setupHandlers();

    // Handle app mentions
    this.setupAppMentionHandler();

    // Handle direct messages
    this.setupDirectMessageHandler();

    // Handle all button/action interactions
    this.setupActionHandler();

    // Handle form submissions
    this.setupFormSubmissionHandler();

    // Handle app home opened event
    this.setupAppHomeHandler();

    // Setup Slack Assistant handlers for assistant threads
    setupAssistantHandlers(this.app, this.messageHandler, this.config);

    logger.info("All Slack event handlers registered successfully");
  }

  /**
   * Handle app mentions in channels
   */
  private setupAppMentionHandler(): void {
    logger.info("Registering app_mention event handler");

    this.app.event("app_mention", async ({ event, client, say, body }) => {
      // Extract team_id from body (top-level Slack event envelope)
      const slackTeamId = (body as any)?.team_id;
      // Allow self-generated app_mentions (for testing via messaging API)
      // These are filtered by MAX_TURNS to prevent infinite loops
      if (isSelfGeneratedEvent(event, this.config, true)) {
        logger.info(
          `Allowing self-generated app_mention for testing (will check MAX_TURNS)`
        );
      }

      logger.info(`App mentioned by ${event.user} in channel ${event.channel}`);

      // Check if user is allowed
      if (!this.messageHandler.isUserAllowed(event.user || "")) {
        logger.warn(`User ${event.user} not in allowed users list`);
        await say({
          text: "Sorry, you don't have permission to use this bot. Please contact your administrator.",
          thread_ts: event.thread_ts || event.ts,
        });
        return;
      }

      // Extract the actual message text (removing the bot mention)
      const userRequest = this.messageHandler.extractUserRequest(event.text);
      const messageText = userRequest.toLowerCase().trim();

      // Check for text commands first (same as DM handler)
      if (
        messageText === "welcome" ||
        messageText === "help" ||
        messageText === "start" ||
        messageText === "onboard"
      ) {
        logger.info(`Handling welcome command via app_mention: ${messageText}`);
        await this.shortcutCommandHandler.handleTextCommand(
          "welcome",
          event.user || "",
          event.channel,
          client as WebClient,
          event.thread_ts || event.ts
        );
        return;
      }

      // Normal message processing
      // Pass slackTeamId from body since event.team may not be present
      const context = this.messageHandler.extractSlackContext(
        event as unknown as SlackMessageEvent,
        slackTeamId
      );

      // Extract file metadata if any (app mentions can have files)
      const eventWithFiles = event as any;
      const files = eventWithFiles.files?.map((file: any) => ({
        id: file.id,
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
        url_private: file.url_private,
        url_private_download: file.url_private_download,
        timestamp: file.timestamp,
      }));

      if (files && files.length > 0) {
        logger.info(`App mention includes ${files.length} file(s)`);
      }

      await this.messageHandler.handleUserRequest(
        context,
        userRequest,
        client as WebClient,
        files
      );
    });
  }

  /**
   * Handle direct messages to the bot
   */
  private setupDirectMessageHandler(): void {
    logger.info("Registering direct message handler");

    this.app.message(async ({ message, client, body }) => {
      const event = message as GenericMessageEvent & { files?: any[] };

      // Extract team_id from body (top-level Slack event envelope)
      const slackTeamId = (body as any)?.team_id;

      // Log all message events for debugging
      logger.info(
        `Message event received - channel: ${event.channel}, channel_type: ${event.channel_type}, subtype: ${event.subtype}, user: ${event.user}, thread_ts: ${event.thread_ts}, files: ${event.files?.length || 0}, body.team_id: ${slackTeamId}, eventKeys: ${Object.keys(event).join(",")}`
      );

      // Handle direct messages - check both channel_type and channel ID pattern
      // DM channels start with 'D' (e.g., D095U1QV667)
      const isDM =
        event.channel_type === "im" ||
        (event.channel &&
          typeof event.channel === "string" &&
          event.channel.startsWith("D"));

      // Handle direct messages without subtype OR file_share subtype (file uploads)
      if ((!message.subtype || message.subtype === "file_share") && isDM) {
        // Ignore messages generated by our own bot only (not other bots)
        if (isSelfGeneratedEvent(event, this.config)) {
          const eventWithBotId = event as { bot_id?: string };
          logger.debug(
            `Ignoring self DM message (bot_id=${eventWithBotId.bot_id}, user=${event.user})`
          );
          return;
        }

        logger.info(`Direct message from ${event.user}: ${event.text}`);

        // Check if user is allowed
        if (!this.messageHandler.isUserAllowed(event.user || "")) {
          logger.warn(`User ${event.user} not in allowed users list`);
          await client.chat.postMessage({
            channel: event.channel,
            text: "Sorry, you don't have permission to use this bot. Please contact your administrator.",
            thread_ts: event.thread_ts || event.ts,
          });
          return;
        }

        // Check for text commands first
        const messageText = event.text?.toLowerCase().trim();
        logger.info(`Checking for text command: "${messageText}"`);

        // Handle text commands that mimic slash commands
        if (
          messageText === "welcome" ||
          messageText === "help" ||
          messageText === "start" ||
          messageText === "onboard"
        ) {
          logger.info(`Handling welcome command via text: ${messageText}`);
          // Reuse the slash command handler's welcome functionality
          await this.shortcutCommandHandler.handleTextCommand(
            "welcome",
            event.user || "",
            event.channel,
            client as WebClient,
            event.thread_ts || event.ts
          );
          return;
        }

        // Normal message processing
        // Pass slackTeamId from body since event.team may not be present for file uploads
        const context = this.messageHandler.extractSlackContext(
          event as SlackMessageEvent,
          slackTeamId
        );
        const userRequest = this.messageHandler.extractUserRequest(
          event.text || ""
        );

        // Extract file metadata if files are attached
        const files = event.files?.map((file) => ({
          id: file.id,
          name: file.name,
          mimetype: file.mimetype,
          size: file.size,
          url_private: file.url_private,
          url_private_download: file.url_private_download,
        }));

        if (files && files.length > 0) {
          logger.info(`Message includes ${files.length} file(s)`);
        }

        await this.messageHandler.handleUserRequest(
          context,
          userRequest,
          client as WebClient,
          files
        );
      }
    });
  }

  /**
   * Handle all button and interactive component actions
   */
  private setupActionHandler(): void {
    logger.info(
      "Registering action handler for buttons and interactive components"
    );

    this.app.action(/.*/, async ({ action, ack, client, body }) => {
      await ack();

      const actionWithId = action as { action_id: string };
      const actionId = actionWithId.action_id;
      const userId = body.user.id;
      const bodyWithChannel = body as {
        channel?: { id: string };
        container?: { channel_id: string };
        message?: { ts: string };
      };
      const channelId =
        bodyWithChannel.channel?.id ||
        bodyWithChannel.container?.channel_id ||
        "";
      const messageTs = bodyWithChannel.message?.ts || "";

      logger.info(`Action received: ${actionId} from user ${userId}`);

      // Delegate to action handler
      await this.actionHandler.handleBlockAction(
        actionId,
        userId,
        channelId,
        messageTs,
        body as import("./types").SlackActionBody,
        client as WebClient
      );
    });
  }

  /**
   * Handle form submission events
   */
  private setupFormSubmissionHandler(): void {
    logger.info("Registering view_submission handler for forms");

    // Register handler for blockkit form modal submissions
    this.app.view(
      "blockkit_form_modal",
      async ({ ack, body, view, client }) => {
        await ack();

        const userId = body.user.id;

        logger.info(
          `Form submission from user ${userId} for blockkit_form_modal`
        );

        await handleBlockkitFormSubmission(
          userId,
          view as View,
          client as WebClient,
          async (
            context: SlackContext,
            userRequest: string,
            client: WebClient
          ) =>
            this.messageHandler.handleUserRequest(context, userRequest, client)
        );
      }
    );

    // Register handler for MCP input modal submissions
    this.app.view(/^mcp_input_modal_/, async ({ ack, body, view, client }) => {
      await ack();

      const userId = body.user.id;
      const viewId = view.id;
      const callbackId = view.callback_id;
      const privateMetadata = view.private_metadata || "{}";
      const values = view.state.values;

      logger.info(
        `MCP input modal submission from user ${userId} for ${callbackId}`
      );

      // Delegate to modules that handle view submissions
      const dispatcherModules = this.moduleRegistry.getDispatcherModules();
      for (const module of dispatcherModules) {
        if (module.handleViewSubmission) {
          try {
            await module.handleViewSubmission(
              viewId,
              userId,
              values,
              privateMetadata
            );
            logger.info(
              `Module ${module.name} handled view submission ${callbackId}`
            );
          } catch (error) {
            logger.error(
              `Module ${module.name} failed to handle view submission:`,
              error
            );
          }
        }
      }

      // Update app home after successful submission
      await this.actionHandler.updateAppHome(userId, client as WebClient);
    });

    // Register handler for Claude OAuth modal submissions (manual auth code entry)
    this.app.view("claude_auth_submit", async ({ ack, body, view, client }) => {
      const userId = body.user.id;
      const values = view.state.values;

      logger.info(`Claude auth modal submission from user ${userId}`);

      // Delegate to Claude OAuth module
      const dispatcherModules = this.moduleRegistry.getDispatcherModules();
      for (const module of dispatcherModules) {
        if (module.name === "claude-oauth" && module.handleViewSubmission) {
          try {
            await module.handleViewSubmission(
              view.id,
              userId,
              values,
              view.private_metadata || "{}"
            );
            logger.info(`Claude OAuth module handled auth modal submission`);

            // Success - acknowledge without errors
            await ack();

            // Update app home after successful submission
            await this.actionHandler.updateAppHome(userId, client as WebClient);
            return;
          } catch (error) {
            logger.error(
              `Claude OAuth module failed to handle auth modal:`,
              error
            );

            // Acknowledge with error to show in modal
            await ack({
              response_action: "errors",
              errors: {
                auth_code_block:
                  error instanceof Error
                    ? error.message
                    : "Authentication failed. Please try again.",
              },
            });
            return;
          }
        }
      }

      // No module handled it - acknowledge anyway
      await ack();
    });

    // Register handler for Claude OAuth callback modal submissions
    this.app.view(
      "claude_auth_callback_submit",
      async ({ ack, body, view, client }) => {
        const userId = body.user.id;
        const privateMetadata = view.private_metadata || "{}";
        const values = view.state.values;

        logger.info(`Claude auth callback submission from user ${userId}`);

        // Delegate to Claude OAuth module
        const dispatcherModules = this.moduleRegistry.getDispatcherModules();
        for (const module of dispatcherModules) {
          if (module.name === "claude-oauth" && module.handleViewSubmission) {
            try {
              await module.handleViewSubmission(
                view.id,
                userId,
                values,
                privateMetadata
              );
              logger.info(
                `Claude OAuth module handled auth callback submission`
              );

              // Success - acknowledge without errors
              await ack();

              // Update app home after successful submission
              await this.actionHandler.updateAppHome(
                userId,
                client as WebClient
              );
              return;
            } catch (error) {
              logger.error(
                `Claude OAuth module failed to handle auth callback:`,
                error
              );

              // Acknowledge with error to show in modal
              await ack({
                response_action: "errors",
                errors: {
                  auth_code_block:
                    error instanceof Error
                      ? error.message
                      : "Authentication failed. Please try again.",
                },
              });
              return;
            }
          }
        }

        // No module handled it - acknowledge anyway
        await ack();
      }
    );
  }

  /**
   * Handle app home opened events
   */
  private setupAppHomeHandler(): void {
    logger.info("Registering app_home_opened event handler");

    this.app.event("app_home_opened", async ({ event, client }) => {
      try {
        if (event.tab === "home") {
          await this.actionHandler.updateAppHome(
            event.user,
            client as WebClient
          );
        }
      } catch (error) {
        logger.error("Error handling app home opened:", error);
      }
    });
  }

  /**
   * Set the channel binding service for agent routing
   */
  setChannelBindingService(
    service: import("../channels").ChannelBindingService
  ): void {
    this.messageHandler.setChannelBindingService(service);
  }

  /**
   * Set the agent settings store for applying agent configuration
   */
  setAgentSettingsStore(
    store: import("../auth/settings").AgentSettingsStore
  ): void {
    this.messageHandler.setAgentSettingsStore(store);
  }

  /**
   * Cleanup method for graceful shutdown
   */
  cleanup(): void {
    logger.info("Cleaning up Slack event handlers");
    this.messageHandler.cleanupExpiredData();
  }
}
