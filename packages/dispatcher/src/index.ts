#!/usr/bin/env bun

import { initSentry } from "@peerbot/shared";

// Initialize Sentry monitoring
initSentry();

import { join } from "node:path";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { config as dotenvConfig } from "dotenv";
import {
  createLogger,
  createDatabaseAdapter,
  type DatabaseAdapter,
} from "@peerbot/shared";

const logger = createLogger("dispatcher");
import {
  type AnthropicProxy,
  createAnthropicProxy,
} from "./proxy/anthropic-proxy";
import { ThreadResponseConsumer } from "./queue/slack-thread-processor";
import { QueueProducer } from "./queue/task-queue-producer";
import { setupHealthEndpoints } from "./simple-http";
import { SlackEventHandlers } from "./slack/slack-event-handlers";
import type { DispatcherConfig } from "./types";
import { moduleRegistry } from "../../../modules";

export class SlackDispatcher {
  private app: App;
  private queueProducer: QueueProducer;
  private threadResponseConsumer?: ThreadResponseConsumer;
  private anthropicProxy?: AnthropicProxy;
  private config: DispatcherConfig;
  private database: DatabaseAdapter;

  constructor(config: DispatcherConfig) {
    this.config = config;

    if (!config.queues?.connectionString) {
      throw new Error("Queue connection string is required");
    }

    // Initialize Slack app based on mode
    if (config.slack.socketMode === false) {
      // HTTP mode - use ExpressReceiver
      const receiver = new ExpressReceiver({
        signingSecret: config.slack.signingSecret!,
        endpoints: {
          events: "/slack/events",
        },
        processBeforeResponse: true,
        logLevel: LogLevel.DEBUG,
      });

      // Add URL verification challenge handler BEFORE Slack middleware
      // This is needed for initial Slack app Event Subscription setup
      receiver.router.use("/slack/events", (req, res, next) => {
        // Check if this is a URL verification challenge
        if (req.body && req.body.type === "url_verification") {
          logger.info("Handling Slack URL verification challenge");
          return res.status(200).json({ challenge: req.body.challenge });
        }
        // Otherwise, continue to normal Slack event handling
        next();
      });

      this.app = new App({
        token: config.slack.token,
        receiver,
        logLevel: config.logLevel || LogLevel.DEBUG,
        ignoreSelf: false, // We need to receive action events from our own messages
      });

      logger.info("Initialized Slack app in HTTP mode with ExpressReceiver");
    } else {
      // Socket mode
      const appConfig: any = {
        signingSecret: config.slack.signingSecret,
        socketMode: true,
        appToken: config.slack.appToken,
        port: config.slack.port || 3000,
        logLevel: config.logLevel || LogLevel.INFO,
        ignoreSelf: false, // We need to receive action events from our own messages
        processBeforeResponse: true,
      };

      if (config.slack.token) {
        appConfig.token = config.slack.token;
      } else {
        throw new Error("SLACK_BOT_TOKEN is required");
      }

      this.app = new App(appConfig);
      logger.info("Initialized Slack app in Socket mode");
    }

    // Initialize shared database adapter and queue producer
    logger.info("Initializing queue mode");
    this.database = createDatabaseAdapter(config.queues.connectionString);
    this.queueProducer = new QueueProducer(
      config.queues.connectionString,
      this.database
    );
    // ThreadResponseConsumer will be created after event handlers are initialized

    this.setupErrorHandling();
    this.setupGracefulShutdown();

    // Add global middleware to log all events
    this.app.use(async ({ payload, next }) => {
      const event = (payload as any).event || payload;
      logger.debug(
        `[Slack Event] Type: ${event?.type}, Subtype: ${event?.subtype}`
      );
      if (event) {
        logger.debug(
          `[Slack Event Details]`,
          JSON.stringify(event).substring(0, 200)
        );
      }
      await next();
    });
  }

  /**
   * Start the dispatcher
   */
  async start(): Promise<void> {
    try {
      // Initialize Anthropic proxy (always enabled for both Socket and HTTP mode)
      this.anthropicProxy = createAnthropicProxy(this.config.anthropicProxy);
      logger.info("✅ Anthropic proxy initialized");

      // Setup health endpoints will be called after event handlers are created

      // Initialize modules
      await moduleRegistry.initAll();
      logger.info("✅ Modules initialized");

      // Start queue producer
      await this.queueProducer.start();
      logger.info("✅ Queue producer started");

      // Get bot's own user ID and bot ID dynamically before starting
      await this.initializeBotInfo(this.config);

      // Start thread response consumer (after event handlers are created)
      if (this.threadResponseConsumer) {
        await this.threadResponseConsumer.start();
        logger.info("✅ Thread response consumer started");
      }

      // We'll test auth after starting the server
      logger.debug(
        `Starting Slack app in ${this.config.slack.socketMode ? "Socket Mode" : "HTTP Mode"}`
      );

      if (this.config.slack.socketMode === false) {
        // In HTTP mode, start with the port
        await this.app.start(this.config.slack.port || 3000);

        // Add debugging info
        const receiver = (this.app as any).receiver as ExpressReceiver;
        const expressApp = receiver.app;

        // Add request logging middleware
        expressApp.use((req: any, _res: any, next: any) => {
          logger.debug(
            `[${new Date().toISOString()}] ${req.method} ${req.path}`
          );
          logger.debug("Headers:", req.headers);
          if (req.method === "POST" && req.body) {
            logger.debug("Body:", JSON.stringify(req.body).substring(0, 200));
          }
          next();
        });

        // No test endpoints in production code

        // Add a health check endpoint
        expressApp.get("/health", (_req, res) => {
          res.json({
            service: "peerbot-dispatcher",
            status: "running",
            mode: "http",
            anthropicProxy: this.config.anthropicProxy?.enabled || false,
          });
        });

        // Mount Anthropic proxy if enabled (HTTP mode - also available on port 8080)
        if (this.anthropicProxy) {
          expressApp.use("/api/anthropic", this.anthropicProxy.getRouter());
          logger.info(
            "✅ Anthropic proxy enabled at /api/anthropic (HTTP mode)"
          );
        }

        logger.debug("Express routes after Slack app start:");
        expressApp._router.stack.forEach((middleware: any) => {
          if (middleware.route) {
            logger.debug(
              `- ${Object.keys(middleware.route.methods).join(", ").toUpperCase()} ${middleware.route.path}`
            );
          } else if (middleware.name === "router") {
            logger.debug("- Router middleware");
          }
        });
      } else {
        // In socket mode, add connection event handlers first
        logger.info("Socket Mode debugging - checking client availability");
        logger.info(
          "App receiver type:",
          (this.app as any).receiver?.constructor.name
        );
        logger.info(
          "Socket Mode client exists:",
          !!(this.app as any).receiver?.client
        );

        const socketModeClient = (this.app as any).receiver?.client;
        if (socketModeClient) {
          logger.info("Setting up Socket Mode event handlers...");
          logger.info(
            "Socket Mode client type:",
            socketModeClient.constructor.name
          );

          socketModeClient.on("slack_event", (event: any, _body: any) => {
            logger.info("Socket Mode event received:", event.type);
          });

          socketModeClient.on("disconnect", () => {
            logger.warn("Socket Mode disconnected, will auto-reconnect");
          });

          socketModeClient.on("error", (error: any) => {
            logger.error("Socket Mode error:", error);
          });

          socketModeClient.on("ready", () => {
            logger.info("Socket Mode client ready");
          });

          socketModeClient.on("connecting", () => {
            logger.info("Socket Mode connecting...");
          });

          socketModeClient.on("connected", () => {
            logger.info("Socket Mode connected successfully!");
          });
        } else {
          logger.warn("No Socket Mode client found in receiver");
        }

        // In socket mode, just start with timeout
        logger.info("Starting Slack app in Socket Mode...");
        logger.info("Config that was used for App constructor:", {
          socketMode: this.config.slack.socketMode,
          appTokenExists: !!this.config.slack.appToken,
          tokenExists: !!this.config.slack.token,
          signingSecretExists: !!this.config.slack.signingSecret,
        });

        try {
          logger.info("Calling app.start()...");
          // The app.start() in Socket Mode doesn't actually resolve the promise properly
          // It connects but keeps the promise pending, so we'll handle it differently
          this.app.start().catch((error) => {
            // Only log real errors, not timeout issues
            if (!error?.message?.includes("timeout")) {
              logger.error("Socket Mode start error:", error);
            }
          });

          // Give Socket Mode a moment to connect
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Check if we're connected via the Socket Mode client
          const receiver = (this.app as any).receiver;
          if (
            receiver?.client?.isConnected?.() ||
            receiver?.client?.stateMachine?.getCurrentState?.() === "connected"
          ) {
            logger.info("✅ Socket Mode connection established!");
          } else {
            // Wait a bit more and check again
            await new Promise((resolve) => setTimeout(resolve, 3000));
            logger.info("✅ Socket Mode connection established!");
          }
        } catch (socketError) {
          logger.error("❌ Failed to start Socket Mode:", socketError);
          throw socketError;
        }
      }

      const mode = this.config.slack.socketMode
        ? "Socket Mode"
        : `HTTP on port ${this.config.slack.port}`;
      logger.info(
        `🚀 Slack Dispatcher is running in ${mode}! (Local Development)`
      );

      // Log configuration
      logger.info("Configuration:");
      logger.info(
        `- Session Timeout: ${this.config.sessionTimeoutMinutes} minutes`
      );
      logger.info(
        `- Signing Secret: ${this.config.slack.signingSecret?.substring(0, 8)}...`
      );
    } catch (error) {
      logger.error("Failed to start Slack dispatcher:", error);
      process.exit(1);
    }
  }

  /**
   * Stop the dispatcher
   */
  async stop(): Promise<void> {
    try {
      await this.app.stop();

      await this.queueProducer.stop();
      if (this.threadResponseConsumer) {
        await this.threadResponseConsumer.stop();
      }

      await this.database.close();

      logger.info("Slack dispatcher stopped");
    } catch (error) {
      logger.error("Error stopping Slack dispatcher:", error);
    }
  }

  /**
   * Get dispatcher status
   */
  getStatus(): {
    isRunning: boolean;
    mode: string;
    config: Partial<DispatcherConfig>;
  } {
    return {
      isRunning: true,
      mode: "queue",
      config: {
        slack: {
          token: this.config.slack.token,
          socketMode: this.config.slack.socketMode,
          port: this.config.slack.port,
        },
        queues: this.config.queues,
      },
    };
  }

  /**
   * Setup error handling
   */
  private async initializeBotInfo(config: DispatcherConfig): Promise<void> {
    try {
      logger.info("Bot IDs not configured, calling auth.test via HTTP...");

      // Use direct HTTP call instead of Slack Bolt client
      const slackApiUrl = process.env.SLACK_API_URL || "https://slack.com/api";
      const response = await fetch(`${slackApiUrl}/auth.test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.slack.token}`,
          "Content-Type": "application/json",
        },
      });

      const authResult = (await response.json()) as any;

      if (!authResult.ok) {
        throw new Error(
          `Auth test failed: ${authResult.error || "Unknown error"}`
        );
      }

      const botUserId = authResult.user_id as string;
      const botId = authResult.bot_id as string;

      logger.info(`Bot initialized - User ID: ${botUserId}, Bot ID: ${botId}`);

      // Store bot info in config for event handlers to use
      config.slack.botUserId = botUserId;
      config.slack.botId = botId;

      // Initialize queue-based event handlers
      logger.info("Initializing queue-based event handlers");
      new SlackEventHandlers(
        this.app,
        this.queueProducer,
        config,
        this.database
      );

      // Now create ThreadResponseConsumer
      this.threadResponseConsumer = new ThreadResponseConsumer(
        config.queues.connectionString,
        config.slack.token
      );

      // Setup health endpoints
      setupHealthEndpoints(this.anthropicProxy);
    } catch (error) {
      logger.error("Failed to get bot info:", error);
      throw new Error("Failed to initialize bot - could not get bot user ID");
    }
  }

  private setupErrorHandling(): void {
    this.app.error(async (error) => {
      logger.error("Slack app error:", error);
      logger.error("Error details:", {
        message: error.message,
        code: (error as any).code,
        data: (error as any).data,
        stack: error.stack,
      });
    });

    process.on("unhandledRejection", (reason, promise) => {
      // Filter out expected Socket Mode connection events
      const reasonStr = String(reason);
      if (
        reasonStr.includes("server explicit disconnect") ||
        reasonStr.includes("Unhandled event") ||
        reasonStr.includes("state machine")
      ) {
        // These are expected Socket Mode reconnection events, just log as debug
        logger.debug(
          "Socket Mode connection event (expected):",
          reasonStr.substring(0, 100)
        );
        return;
      }

      logger.error("Unhandled Rejection at:", promise, "reason:", reason);
      // Don't exit on unhandled rejections during startup
      // The app might still work despite some initialization errors
    });

    process.on("uncaughtException", (error) => {
      const errorStr = error?.toString() || "";
      const messageStr = (error as any)?.message || "";

      // Check if this is a Socket Mode connection error that should be ignored
      if (
        errorStr.includes("server explicit disconnect") ||
        messageStr.includes("server explicit disconnect") ||
        errorStr.includes("Unhandled event") ||
        messageStr.includes("Unhandled event") ||
        errorStr.includes("state machine") ||
        messageStr.includes("state machine")
      ) {
        // These are expected Socket Mode reconnection events, just log as debug
        logger.debug(
          "Socket Mode connection exception (expected, will reconnect):",
          errorStr.substring(0, 100)
        );
        return;
      }

      logger.error("Uncaught Exception:", error);
      process.exit(1);
    });
  }

  /**
   * Setup graceful shutdown
   */
  private setupGracefulShutdown(): void {
    const cleanup = async () => {
      logger.info("Shutting down Slack dispatcher...");

      // Stop accepting new jobs
      await this.stop();

      // Queue cleanup is handled by stop()

      logger.info("Slack dispatcher shutdown complete");
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Load environment variables from project root
    const envPath = join(__dirname, "../../../.env");
    dotenvConfig({ path: envPath });
    logger.info("🚀 Starting Claude Code Slack Dispatcher");

    // Get bot token from environment
    const botToken = process.env.SLACK_BOT_TOKEN;

    // Load configuration from environment
    logger.info("Environment variables debug:", {
      botToken: `${botToken?.substring(0, 10)}...`,
      appToken: `${process.env.SLACK_APP_TOKEN?.substring(0, 10)}...`,
      signingSecret: `${process.env.SLACK_SIGNING_SECRET?.substring(0, 10)}...`,
    });

    const config: DispatcherConfig = {
      slack: {
        token: botToken!,
        appToken: process.env.SLACK_APP_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: process.env.SLACK_HTTP_MODE !== "true",
        port: parseInt(process.env.PORT || "3000", 10),
        botUserId: process.env.SLACK_BOT_USER_ID,
        allowedUsers: process.env.SLACK_ALLOWED_USERS?.split(","),
        allowedChannels: process.env.SLACK_ALLOWED_CHANNELS?.split(","),
      },
      claude: {
        allowedTools: process.env.ALLOWED_TOOLS?.split(","),
        model: process.env.AGENT_DEFAULT_MODEL,
        timeoutMinutes: process.env.TIMEOUT_MINUTES
          ? Number(process.env.TIMEOUT_MINUTES)
          : undefined,
      },
      sessionTimeoutMinutes: parseInt(
        process.env.SESSION_TIMEOUT_MINUTES || "5",
        10
      ),
      logLevel: (process.env.LOG_LEVEL as any) || LogLevel.INFO,
      // Queue configuration (required)
      queues: {
        connectionString: process.env.DATABASE_URL!,
        directMessage: process.env.QUEUE_DIRECT_MESSAGE || "direct_message",
        messageQueue: process.env.QUEUE_MESSAGE_QUEUE || "message_queue",
        retryLimit: parseInt(process.env.PGBOSS_RETRY_LIMIT || "3", 10),
        retryDelay: parseInt(process.env.PGBOSS_RETRY_DELAY || "30", 10),
        expireInHours: parseInt(process.env.PGBOSS_EXPIRE_HOURS || "24", 10),
      },
      // Anthropic proxy configuration (always enabled)
      anthropicProxy: {
        enabled: true,
        anthropicApiKey:
          process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN!,
        postgresConnectionString: process.env.DATABASE_URL!,
        anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      },
    };

    logger.info("Final config debug:", {
      slackToken: `${config.slack.token?.substring(0, 10)}...`,
      slackAppToken: `${config.slack.appToken?.substring(0, 10)}...`,
      slackSigningSecret: `${config.slack.signingSecret?.substring(0, 10)}...`,
      socketMode: config.slack.socketMode,
    });

    // Validate required configuration
    if (!config.slack.token) {
      throw new Error("SLACK_BOT_TOKEN is required");
    }
    if (!config.queues.connectionString) {
      throw new Error("DATABASE_URL is required");
    }

    // Create and start dispatcher
    const dispatcher = new SlackDispatcher(config);
    await dispatcher.start();

    logger.info("✅ Claude Code Slack Dispatcher is running!");

    // Handle health checks
    process.on("SIGUSR1", () => {
      const status = dispatcher.getStatus();
      logger.info("Health check:", JSON.stringify(status, null, 2));
    });
  } catch (error) {
    logger.error("❌ Failed to start Slack Dispatcher:", error);
    process.exit(1);
  }
}

// Start the application
main();

export type { DispatcherConfig } from "./types";
