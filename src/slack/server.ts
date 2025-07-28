#!/usr/bin/env bun

import { App, LogLevel } from "@slack/bolt";
import { SlackApiClient } from "./api/client";
import { SlackMessageManager } from "./operations/message";
import { SlackReactionManager } from "./operations/reactions";
import { SlackStreamingManager } from "./streaming";
import { registerSlackEventHandlers } from "./events/handlers";
import type { TriggerDetectionConfig } from "./events/handlers";
import type { SlackContext, SlackRunContext } from "./types";
import { convertSlackToGenericContext } from "./context";
import { runClaudeWithProgress } from "../core/claude-runner";
import { createPromptFile } from "../core/prompt";
import type { ClaudeExecutionOptions } from "../core/claude-runner";

export interface SlackServerConfig {
  // Slack app configuration
  token: string;
  appToken?: string;
  signingSecret?: string;
  socketMode?: boolean;
  port?: number;
  
  // Bot configuration
  botUserId?: string;
  triggerPhrase?: string;
  
  // Permissions
  allowDirectMessages?: boolean;
  allowPrivateChannels?: boolean;
  allowedUsers?: string[];
  blockedUsers?: string[];
  allowedChannels?: string[];
  blockedChannels?: string[];
  
  // Claude configuration
  claudeOptions?: ClaudeExecutionOptions;
  customInstructions?: string;
  mcpConfigPath?: string;
  
  // Features
  enableStatusReactions?: boolean;
  enableProgressUpdates?: boolean;
  
  // Environment
  nodeEnv?: string;
  logLevel?: LogLevel;
}

export class SlackServer {
  private app: App;
  private client: SlackApiClient;
  private messageManager: SlackMessageManager;
  private reactionManager: SlackReactionManager;
  private streamingManager: SlackStreamingManager;
  private config: SlackServerConfig;
  private activeExecutions = new Map<string, SlackRunContext>();

  constructor(config: SlackServerConfig) {
    this.config = config;

    // Initialize Slack app
    this.app = new App({
      token: config.token,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: config.socketMode !== false, // Default to socket mode
      port: config.port || 3000,
      logLevel: config.logLevel || LogLevel.INFO,
      // Ignore self events
      ignoreSelf: true,
    });

    // Initialize API client and managers
    this.client = new SlackApiClient({ token: config.token });
    this.messageManager = new SlackMessageManager(this.client);
    this.reactionManager = new SlackReactionManager(this.client, {
      enableStatusReactions: config.enableStatusReactions,
    });
    this.streamingManager = new SlackStreamingManager(
      this.messageManager,
      this.reactionManager,
      {
        enableProgressUpdates: config.enableProgressUpdates,
      },
    );

    this.setupEventHandlers();
    this.setupErrorHandling();
    this.setupGracefulShutdown();
  }

  /**
   * Setup Slack event handlers
   */
  private setupEventHandlers(): void {
    const triggerConfig: TriggerDetectionConfig = {
      triggerPhrase: this.config.triggerPhrase,
      botUserId: this.config.botUserId,
      allowDirectMessages: this.config.allowDirectMessages,
      allowPrivateChannels: this.config.allowPrivateChannels,
      allowedUsers: this.config.allowedUsers,
      blockedUsers: this.config.blockedUsers,
      allowedChannels: this.config.allowedChannels,
      blockedChannels: this.config.blockedChannels,
    };

    registerSlackEventHandlers(
      this.app,
      triggerConfig,
      this.handleTrigger.bind(this),
    );
  }

  /**
   * Handle triggered events (app mentions or message triggers)
   */
  private async handleTrigger(
    context: SlackContext,
    extractedText: string,
  ): Promise<void> {
    const executionId = `${context.channelId}-${context.messageTs}`;
    
    // Check if we're already processing this request
    if (this.activeExecutions.has(executionId)) {
      console.log("Already processing request:", executionId);
      return;
    }

    try {
      // Add working reaction to user's message
      await this.reactionManager.setWorkingStatus(context);

      // Create initial response message
      const initialResponse = await this.messageManager.createInitialResponse(
        context,
        "I'm working on your request...",
      );

      if (!initialResponse.success) {
        console.error("Failed to create initial response:", initialResponse.error);
        await this.reactionManager.setErrorStatus(context);
        return;
      }

      // Track this execution
      const runContext: SlackRunContext = {
        context,
        initialMessageTs: initialResponse.messageTs,
        workingReactionAdded: true,
        executionStartTime: Date.now(),
        claudeExecutionId: executionId,
      };
      this.activeExecutions.set(executionId, runContext);

      // Start Claude execution
      await this.executeClaudeRequest(runContext, extractedText);

    } catch (error) {
      console.error("Error handling trigger:", error);
      await this.reactionManager.setErrorStatus(context);
      
      // Try to update message with error
      const runContext = this.activeExecutions.get(executionId);
      if (runContext) {
        await this.messageManager.updateResponse(
          context.channelId,
          runContext.initialMessageTs,
          `❌ **Error:** ${error instanceof Error ? error.message : "Unknown error occurred"}`,
        );
      }
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  /**
   * Execute Claude request with streaming updates
   */
  private async executeClaudeRequest(
    runContext: SlackRunContext,
    userRequest: string,
  ): Promise<void> {
    const { context } = runContext;

    try {
      // Get user info for better context
      const userInfo = await this.client.getUserInfo(context.userId);
      
      // Get recent messages for context
      const messages = await this.client.getConversationHistory(
        context.channelId,
        { limit: 10 }
      );

      // Convert to generic context
      const genericContext = convertSlackToGenericContext(context, {
        triggerPhrase: this.config.triggerPhrase,
        customInstructions: this.config.customInstructions,
        directPrompt: userRequest,
        messages,
        userDisplayName: userInfo?.displayName || userInfo?.realName,
        botUserId: this.config.botUserId,
      });

      // Create prompt file
      const promptPath = await createPromptFile(genericContext);

      // Start streaming monitoring
      await this.streamingManager.startStreaming(
        context,
        runContext.initialMessageTs,
      );

      // Execute Claude with progress callback
      const result = await runClaudeWithProgress(
        promptPath,
        this.config.claudeOptions || {},
        async (update) => {
          // Handle progress updates via streaming manager
          if (update.type === "output") {
            await this.streamingManager.updateProgress(
              context,
              runContext.initialMessageTs,
              {
                content: this.messageManager.formatMessage(update.data, "progress"),
                isComplete: false,
              },
            );
          }
        },
        genericContext,
      );

      // Handle final result
      const duration = Date.now() - runContext.executionStartTime;
      
      if (result.success) {
        await this.streamingManager.completeExecution(
          context,
          runContext.initialMessageTs,
          result.output || "Execution completed successfully.",
          {
            duration,
            success: true,
          },
        );
      } else {
        await this.streamingManager.handleExecutionError(
          context,
          runContext.initialMessageTs,
          result.error || "Execution failed",
        );
      }

    } catch (error) {
      console.error("Error executing Claude request:", error);
      
      await this.streamingManager.handleExecutionError(
        context,
        runContext.initialMessageTs,
        error instanceof Error ? error.message : "Unknown error occurred",
      );
    }
  }

  /**
   * Setup error handling
   */
  private setupErrorHandling(): void {
    this.app.error(async (error) => {
      console.error("Slack app error:", error);
    });

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
    });

    process.on("uncaughtException", (error) => {
      console.error("Uncaught Exception:", error);
      process.exit(1);
    });
  }

  /**
   * Setup graceful shutdown
   */
  private setupGracefulShutdown(): void {
    const cleanup = async () => {
      console.log("Shutting down Slack server...");
      
      // Wait for active executions to complete (with timeout)
      const activeCount = this.activeExecutions.size;
      if (activeCount > 0) {
        console.log(`Waiting for ${activeCount} active executions to complete...`);
        
        const timeout = setTimeout(() => {
          console.log("Timeout reached, forcing shutdown");
          process.exit(0);
        }, 30000); // 30 second timeout

        // Wait for executions to complete
        while (this.activeExecutions.size > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        clearTimeout(timeout);
      }

      // Cleanup resources
      this.streamingManager.cleanup();
      
      console.log("Slack server shutdown complete");
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  /**
   * Start the Slack server
   */
  async start(): Promise<void> {
    try {
      await this.app.start();
      
      const mode = this.config.socketMode ? "Socket Mode" : `HTTP on port ${this.config.port}`;
      console.log(`⚡️ Slack app is running in ${mode}!`);
      
      // Log configuration
      console.log("Configuration:");
      console.log(`- Bot User ID: ${this.config.botUserId || "Auto-detect"}`);
      console.log(`- Trigger Phrase: ${this.config.triggerPhrase || "@bot"}`);
      console.log(`- Direct Messages: ${this.config.allowDirectMessages ? "Allowed" : "Blocked"}`);
      console.log(`- Private Channels: ${this.config.allowPrivateChannels ? "Allowed" : "Blocked"}`);
      console.log(`- Status Reactions: ${this.config.enableStatusReactions !== false ? "Enabled" : "Disabled"}`);
      console.log(`- Progress Updates: ${this.config.enableProgressUpdates !== false ? "Enabled" : "Disabled"}`);
      
    } catch (error) {
      console.error("Failed to start Slack app:", error);
      process.exit(1);
    }
  }

  /**
   * Stop the Slack server
   */
  async stop(): Promise<void> {
    try {
      await this.app.stop();
      this.streamingManager.cleanup();
      console.log("Slack server stopped");
    } catch (error) {
      console.error("Error stopping Slack server:", error);
    }
  }

  /**
   * Get server status
   */
  getStatus(): {
    isRunning: boolean;
    activeExecutions: number;
    config: Partial<SlackServerConfig>;
  } {
    return {
      isRunning: true, // TODO: Add proper running state tracking
      activeExecutions: this.activeExecutions.size,
      config: {
        socketMode: this.config.socketMode,
        port: this.config.port,
        triggerPhrase: this.config.triggerPhrase,
        enableStatusReactions: this.config.enableStatusReactions,
        enableProgressUpdates: this.config.enableProgressUpdates,
      },
    };
  }
}