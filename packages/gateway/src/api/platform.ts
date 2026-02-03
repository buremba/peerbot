#!/usr/bin/env bun

/**
 * API Platform Adapter
 * Handles direct API access for browser extensions, CLI clients, etc.
 * Does not require external platform integration (no Slack, Discord, etc.)
 */

import { randomUUID } from "node:crypto";
import {
  createLogger,
  type InstructionProvider,
  type UserInteraction,
} from "@peerbot/core";
import type { CoreServices, PlatformAdapter } from "../platform";
import type { ResponseRenderer } from "../platform/response-renderer";
import { broadcastToAgent } from "../routes/public/agent";
import type { ThreadSession } from "../session";
import { ApiResponseRenderer } from "./response-renderer";

const logger = createLogger("api-platform");

/**
 * API Platform configuration
 */
export interface ApiPlatformConfig {
  /** Whether the API platform is enabled */
  enabled?: boolean;
}

/**
 * API Platform adapter for direct access via HTTP/SSE
 * This platform doesn't interact with external services like Slack or Discord.
 * Instead, it provides endpoints for:
 * - Creating sessions
 * - Sending messages
 * - Receiving streaming responses via SSE
 * - Handling tool approvals
 */
export class ApiPlatform implements PlatformAdapter {
  readonly name = "api";

  private responseRenderer?: ApiResponseRenderer;
  private isRunning = false;
  private services?: CoreServices;

  /**
   * Initialize with core services
   */
  async initialize(services: CoreServices): Promise<void> {
    logger.info("Initializing API platform...");

    this.services = services;

    // Create response renderer for routing worker responses to SSE clients
    this.responseRenderer = new ApiResponseRenderer();

    // Subscribe to interaction events to handle tool approvals
    const interactionService = services.getInteractionService();
    interactionService.on("interaction:created", (interaction) => {
      // Only handle API platform interactions
      if (interaction.teamId === "api") {
        this.handleToolApproval(interaction).catch((error) => {
          logger.error("Failed to handle tool approval:", error);
        });
      }
    });

    logger.info("✅ API platform initialized");
  }

  /**
   * Start the platform
   * For API platform, this is mostly a no-op since routes are registered separately
   */
  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("✅ API platform started");
  }

  /**
   * Stop the platform
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info("✅ API platform stopped");
  }

  /**
   * Check if platform is healthy
   */
  isHealthy(): boolean {
    return this.isRunning;
  }

  /**
   * No custom instruction provider for API platform
   */
  getInstructionProvider(): InstructionProvider | null {
    return null;
  }

  /**
   * Build deployment metadata
   * For API sessions, we include session ID and source
   */
  buildDeploymentMetadata(
    threadId: string,
    channelId: string,
    platformMetadata: Record<string, any>
  ): Record<string, string> {
    return {
      sessionId: platformMetadata.sessionId || threadId,
      source: "direct-api",
      channelId,
    };
  }

  /**
   * Get the response renderer for routing worker responses
   */
  getResponseRenderer(): ResponseRenderer | undefined {
    return this.responseRenderer;
  }

  /**
   * Handle tool approval requests by sending them via SSE
   */
  private async handleToolApproval(
    interaction: UserInteraction
  ): Promise<void> {
    const agentId = interaction.threadId;
    if (!agentId) {
      logger.warn("No agent ID found for tool approval interaction");
      return;
    }

    // Send tool approval request to SSE clients
    broadcastToAgent(agentId, "tool_approval", {
      type: "tool_approval",
      interactionId: interaction.id,
      interactionType: interaction.interactionType,
      question: interaction.question,
      options: interaction.options,
      expiresAt: interaction.expiresAt,
      timestamp: Date.now(),
    });

    logger.info(`Sent tool approval to agent ${agentId}: ${interaction.id}`);
  }

  /**
   * API platform doesn't render interactions via platform UI
   * Instead, interactions are sent via SSE to the client
   */
  async renderInteraction(): Promise<void> {
    // Interactions are handled via SSE in the response renderer
  }

  /**
   * API platform doesn't render suggestions via platform UI
   */
  async renderSuggestion(): Promise<void> {
    // Suggestions are handled via SSE in the response renderer
  }

  /**
   * API platform doesn't have thread status indicators
   */
  async setThreadStatus(): Promise<void> {
    // Status is sent via SSE events
  }

  /**
   * Send a message via API platform
   * Creates or reuses a session and queues the message for processing
   *
   * @param token - Auth token (used to derive userId)
   * @param message - Message content
   * @param options - Routing info (agentId = channelId = threadId for API)
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
    if (!this.services) {
      throw new Error("API platform not initialized");
    }

    const { agentId } = options;
    const sessionManager = this.services.getSessionManager();
    const queueProducer = this.services.getQueueProducer();
    const messageId = randomUUID();
    const userId = `api-${token.slice(0, 8) || "anonymous"}`;

    // For API platform: agentId = channelId = threadId (all same)
    // Try to get existing session or create new one
    let session = await sessionManager.getSession(agentId);

    if (!session) {
      session = {
        sessionKey: agentId,
        threadId: agentId,
        channelId: agentId,
        userId,
        threadCreator: userId,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        status: "created",
        provider: "claude",
      } as ThreadSession;

      await sessionManager.setSession(session);
      logger.info(`Created new API session: ${agentId}`);
    }

    // Update session activity
    await sessionManager.touchSession(agentId);

    // Prepare message with file info if provided
    const platformMetadata: Record<string, any> = {
      agentId,
      source: "messaging-api",
    };

    if (options.files && options.files.length > 0) {
      platformMetadata.fileCount = options.files.length;
      platformMetadata.fileNames = options.files.map((f) => f.filename);
      logger.info(
        `Message includes ${options.files.length} file(s): ${platformMetadata.fileNames.join(", ")}`
      );
    }

    // Enqueue message for worker processing
    await queueProducer.enqueueMessage({
      userId,
      threadId: agentId,
      messageId,
      channelId: agentId,
      teamId: "api",
      agentId: agentId, // agentId is the isolation boundary
      botId: "peerbot-api",
      platform: "api",
      messageText: message,
      platformMetadata,
      agentOptions: {
        provider: session.provider || "claude",
      },
    });

    logger.info(`Queued message ${messageId} for agent ${agentId}`);

    const publicUrl = this.services.getPublicGatewayUrl();
    const baseUrl = publicUrl || "http://localhost:8080";

    return {
      messageId,
      eventsUrl: `${baseUrl}/api/v1/agents/${agentId}/events`,
      queued: true,
    };
  }
}
