#!/usr/bin/env bun

/**
 * API Platform Adapter
 * Handles direct API access for browser extensions, CLI clients, etc.
 * Does not require external platform integration (no Slack, Discord, etc.)
 */

import { randomUUID } from "node:crypto";
import { createLogger, type InstructionProvider } from "@lobu/core";
import type { CoreServices, PlatformAdapter } from "../platform";
import type { ResponseRenderer } from "../platform/response-renderer";
import { broadcastToAgent } from "../routes/public/agent";
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
    logger.debug("Initializing API platform...");

    this.services = services;

    // Create response renderer for routing worker responses to SSE clients
    this.responseRenderer = new ApiResponseRenderer();

    // Subscribe to interaction events to broadcast to SSE clients
    const interactionService = services.getInteractionService();

    interactionService.on("question:created", (event: any) => {
      if (event.teamId !== "api") return;
      broadcastToAgent(event.conversationId, "question", {
        type: "question",
        questionId: event.id,
        question: event.question,
        options: event.options,
        timestamp: Date.now(),
      });
    });

    interactionService.on("link-button:created", (event: any) => {
      if (event.platform !== "api") return;
      broadcastToAgent(event.conversationId, "link-button", {
        type: "link-button",
        url: event.url,
        label: event.label,
        linkType: event.linkType,
        timestamp: Date.now(),
      });
    });

    interactionService.on("grant:requested", (event: any) => {
      if (event.teamId !== "api") return;
      broadcastToAgent(event.conversationId, "grant-request", {
        type: "grant-request",
        requestId: event.id,
        domains: event.domains,
        reason: event.reason,
        timestamp: Date.now(),
      });
    });

    interactionService.on("package:requested", (event: any) => {
      if (event.teamId !== "api") return;
      broadcastToAgent(event.conversationId, "package-request", {
        type: "package-request",
        requestId: event.id,
        packages: event.packages,
        reason: event.reason,
        timestamp: Date.now(),
      });
    });

    interactionService.on("config:requested", (event: any) => {
      if (event.teamId !== "api") return;
      broadcastToAgent(event.conversationId, "config-request", {
        type: "config-request",
        requestId: event.id,
        text: event.text,
        timestamp: Date.now(),
      });
    });

    interactionService.on("suggestion:created", (event: any) => {
      if (event.teamId !== "api") return;
      broadcastToAgent(event.conversationId, "suggestion", {
        type: "suggestion",
        prompts: event.prompts,
        timestamp: Date.now(),
      });
    });

    logger.debug("✅ API platform initialized");
  }

  /**
   * Start the platform
   * For API platform, this is mostly a no-op since routes are registered separately
   */
  async start(): Promise<void> {
    this.isRunning = true;
    logger.debug("✅ API platform started");
  }

  /**
   * Stop the platform
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    logger.debug("✅ API platform stopped");
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
    conversationId: string,
    channelId: string,
    platformMetadata: Record<string, any>
  ): Record<string, string> {
    return {
      sessionId: platformMetadata.sessionId || conversationId,
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
   * Suggestions are broadcast via interaction events above
   */
  async renderSuggestion(): Promise<void> {
    /* noop — suggestions broadcast via interaction events */
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
   * @param options - Routing info (agentId = channelId = conversationId for API)
   */
  async sendMessage(
    token: string,
    message: string,
    options: {
      agentId: string;
      channelId: string;
      conversationId: string;
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

    // For API platform: agentId = channelId = conversationId (all same)
    // Try to get existing session or create new one
    let session = await sessionManager.getSession(agentId);

    if (!session) {
      session = {
        conversationId: agentId,
        channelId: agentId,
        userId,
        threadCreator: userId,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        status: "created",
        provider: "claude",
      };

      await sessionManager.setSession(session);
      logger.info(`Created new API session: ${agentId}`);
    }

    if (!session) {
      throw new Error("Session not found after creation");
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
      conversationId: agentId,
      messageId,
      channelId: agentId,
      teamId: "api",
      agentId: agentId, // agentId is the isolation boundary
      botId: "lobu-api",
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
