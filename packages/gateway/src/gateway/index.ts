#!/usr/bin/env bun

import type { InstructionContext, WorkerTokenData } from "@peerbot/core";
import { createLogger, verifyWorkerToken } from "@peerbot/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { McpConfigService } from "../auth/mcp/config-service";
import type { IMessageQueue } from "../infrastructure/queue";
import type { InteractionService } from "../interactions";
import { generateDeploymentName } from "../orchestration/base-deployment-manager";
import type { InstructionService } from "../services/instruction-service";
import type { ISessionManager } from "../session";
import { type SSEWriter, WorkerConnectionManager } from "./connection-manager";
import { WorkerJobRouter } from "./job-router";

const logger = createLogger("worker-gateway");

/**
 * Worker Gateway - SSE and HTTP endpoints for worker communication
 * Workers connect via SSE to receive jobs, send responses via HTTP POST
 * Uses encrypted tokens for authentication and routing
 */
export class WorkerGateway {
  private app: Hono;
  private connectionManager: WorkerConnectionManager;
  private jobRouter: WorkerJobRouter;
  private queue: IMessageQueue;
  private mcpConfigService: McpConfigService;
  private instructionService: InstructionService;
  private interactionService: InteractionService;
  private publicGatewayUrl: string;

  constructor(
    queue: IMessageQueue,
    publicGatewayUrl: string,
    sessionManager: ISessionManager,
    mcpConfigService: McpConfigService,
    instructionService: InstructionService,
    interactionService: InteractionService
  ) {
    this.queue = queue;
    this.publicGatewayUrl = publicGatewayUrl;
    this.connectionManager = new WorkerConnectionManager();
    this.jobRouter = new WorkerJobRouter(
      queue,
      this.connectionManager,
      sessionManager
    );
    this.mcpConfigService = mcpConfigService;
    this.instructionService = instructionService;
    this.interactionService = interactionService;

    // Listen for interaction responses and forward to workers via SSE
    this.interactionService.on("interaction:responded", (interaction) => {
      this.handleInteractionResponse(interaction).catch((error) => {
        logger.error("Error handling interaction response:", error);
      });
    });

    // Setup Hono app
    this.app = new Hono();
    this.setupRoutes();
  }

  /**
   * Get the Hono app
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Setup routes on Hono app
   */
  private setupRoutes() {
    // SSE endpoint for workers to receive jobs
    // Routes are mounted at /worker, so paths here should be relative
    this.app.get("/stream", (c) => this.handleStreamConnection(c));

    // HTTP POST endpoint for workers to send responses
    this.app.post("/response", (c) => this.handleWorkerResponse(c));

    // Unified session context endpoint (includes MCP + instructions)
    this.app.get("/session-context", (c) =>
      this.handleSessionContextRequest(c)
    );

    logger.info("Worker gateway routes registered");
  }

  /**
   * Handle SSE connection from worker
   */
  private async handleStreamConnection(c: Context): Promise<Response> {
    const auth = this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { deploymentName, userId, threadId } = auth.tokenData;

    // Create an SSE stream
    return stream(c, async (streamWriter) => {
      // Create an SSE writer adapter
      const sseWriter: SSEWriter = {
        write: (data: string): boolean => {
          try {
            streamWriter.write(data);
            return true;
          } catch {
            return false;
          }
        },
        end: () => {
          try {
            streamWriter.close();
          } catch {
            // Already closed
          }
        },
        onClose: (callback: () => void) => {
          // Handle abort signal
          c.req.raw.signal.addEventListener("abort", callback);
        },
      };

      // Set SSE headers
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");

      // Register connection with connection manager
      this.connectionManager.addConnection(
        deploymentName,
        userId,
        threadId,
        sseWriter
      );

      // Register BullMQ worker for this deployment
      await this.jobRouter.registerWorker(deploymentName);
      await this.jobRouter.resumeWorker(deploymentName);

      // Send any pending interaction responses
      await this.sendPendingInteractionResponses(threadId, deploymentName);

      // Handle client disconnect
      sseWriter.onClose(() => {
        this.jobRouter.pauseWorker(deploymentName).catch((err) => {
          logger.error(`Failed to pause worker ${deploymentName}:`, err);
        });
        this.connectionManager.removeConnection(deploymentName);
      });

      // Keep the connection open until client disconnects
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve());
      });
    });
  }

  /**
   * Handle HTTP response from worker
   */
  private async handleWorkerResponse(c: Context): Promise<Response> {
    const auth = this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { deploymentName } = auth.tokenData;

    // Update connection activity
    this.connectionManager.touchConnection(deploymentName);

    try {
      const body = await c.req.json();
      const { jobId, ...responseData } = body;

      // Acknowledge job completion if jobId provided
      if (jobId) {
        this.jobRouter.acknowledgeJob(jobId);
      }

      // Log for debugging
      logger.info(
        `[WORKER-GATEWAY] Received response with fields: ${Object.keys(responseData).join(", ")}`
      );
      if (responseData.delta) {
        logger.info(
          `[WORKER-GATEWAY] Stream delta: deltaLength=${responseData.delta.length}`
        );
      }

      // Send response to thread_response queue
      await this.queue.send("thread_response", responseData);

      return c.json({ success: true });
    } catch (error) {
      logger.error(`Error handling worker response: ${error}`);
      return c.json({ error: "Failed to process response" }, 500);
    }
  }

  /**
   * Unified session context endpoint
   */
  private async handleSessionContextRequest(c: Context): Promise<Response> {
    if (!this.mcpConfigService || !this.instructionService) {
      return c.json({ error: "session_context_unavailable" }, 503);
    }

    const auth = this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    try {
      const {
        userId,
        platform,
        sessionKey,
        threadId,
        agentId,
        deploymentName,
      } = auth.tokenData;
      const baseUrl = this.getRequestBaseUrl(c);

      // Build instruction context
      const instructionContext: InstructionContext = {
        userId,
        agentId: agentId || "",
        sessionKey: sessionKey || "",
        workingDirectory: "/workspace",
        availableProjects: [],
      };

      // Fetch MCP config, session context, and pending interactions in parallel
      const [mcpConfig, contextData, unansweredInteractions] =
        await Promise.all([
          this.mcpConfigService.getWorkerConfig({
            baseUrl,
            workerToken: auth.token,
            deploymentName,
          }),
          this.instructionService.getSessionContext(
            platform || "unknown",
            instructionContext
          ),
          this.interactionService.getPendingUnansweredInteractions(threadId),
        ]);

      logger.info(
        `Session context for ${userId}: ${Object.keys(mcpConfig.mcpServers || {}).length} MCPs, ${contextData.platformInstructions.length} chars platform instructions, ${contextData.networkInstructions.length} chars network instructions, ${contextData.mcpStatus.length} MCP status entries, ${unansweredInteractions.length} unanswered interactions`
      );

      return c.json({
        mcpConfig,
        platformInstructions: contextData.platformInstructions,
        networkInstructions: contextData.networkInstructions,
        mcpStatus: contextData.mcpStatus,
        unansweredInteractions,
      });
    } catch (error) {
      logger.error("Failed to generate session context", { error });
      return c.json({ error: "session_context_error" }, 500);
    }
  }

  private authenticateWorker(
    c: Context
  ): { tokenData: WorkerTokenData; token: string } | null {
    const authHeader = c.req.header("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);
    const tokenData = verifyWorkerToken(token);

    if (!tokenData) {
      logger.warn("Invalid token");
      return null;
    }

    return { tokenData, token };
  }

  private getRequestBaseUrl(c: Context): string {
    const forwardedProto = c.req.header("x-forwarded-proto");
    const protocolCandidate = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto?.split(",")[0];
    const protocol = (protocolCandidate || "http").trim();
    const host = c.req.header("host");
    if (host) {
      return `${protocol}://${host}`;
    }
    return this.publicGatewayUrl;
  }

  /**
   * Get active worker connections
   */
  getActiveConnections(): string[] {
    return this.connectionManager.getActiveConnections();
  }

  /**
   * Handle interaction response and send to worker via SSE
   */
  private async handleInteractionResponse(interaction: any): Promise<void> {
    const deploymentName = generateDeploymentName(
      interaction.userId,
      interaction.threadId
    );
    const connection = this.connectionManager.getConnection(deploymentName);

    if (!connection) {
      logger.warn(
        `No worker connection found for interaction ${interaction.id} (deployment: ${deploymentName}), storing in Redis`
      );
      await this.storeInteractionResponse(interaction);
      return;
    }

    const success = this.connectionManager.sendSSE(
      connection.writer,
      "interaction",
      {
        interactionId: interaction.id,
        interactionType: interaction.interactionType,
        response: interaction.response,
      }
    );

    if (success) {
      logger.info(
        `✅ Sent interaction response ${interaction.id} to worker ${deploymentName}`
      );
    } else {
      logger.error(
        `❌ Failed to send interaction response ${interaction.id} to worker ${deploymentName} - storing in Redis`
      );
      await this.storeInteractionResponse(interaction);
    }
  }

  /**
   * Store interaction response in Redis for later retrieval
   */
  private async storeInteractionResponse(interaction: any): Promise<void> {
    if (!this.interactionService) return;

    const key = `interaction:response:${interaction.threadId}:${interaction.id}`;
    const response = {
      interactionId: interaction.id,
      response: interaction.response,
    };

    const redis = (this.interactionService as any).redis;
    await redis.set(key, JSON.stringify(response), "EX", 3600);

    logger.info(
      `Stored interaction response ${interaction.id} in Redis for later delivery`
    );
  }

  /**
   * Send any pending interaction responses on reconnect
   */
  private async sendPendingInteractionResponses(
    threadId: string,
    deploymentName: string
  ): Promise<void> {
    if (!this.interactionService) return;

    const redis = (this.interactionService as any).redis;
    const pattern = `interaction:response:${threadId}:*`;
    const keys = await redis.keys(pattern);

    if (keys.length === 0) return;

    logger.info(
      `Found ${keys.length} pending interaction responses for thread ${threadId}`
    );

    const connection = this.connectionManager.getConnection(deploymentName);
    if (!connection) {
      logger.warn(
        `No connection found for ${deploymentName} to send pending responses`
      );
      return;
    }

    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;

      try {
        const responseData = JSON.parse(data);

        const success = this.connectionManager.sendSSE(
          connection.writer,
          "interaction",
          responseData
        );

        if (success) {
          logger.info(
            `✅ Sent pending interaction response ${responseData.interactionId}`
          );
          await redis.del(key);
        } else {
          logger.warn(
            `Failed to send pending response ${responseData.interactionId}, will retry on next reconnect`
          );
        }
      } catch (error) {
        logger.error(`Error sending pending interaction response:`, error);
      }
    }
  }

  /**
   * Shutdown gateway
   */
  shutdown(): void {
    this.connectionManager.shutdown();
    this.jobRouter.shutdown();
  }
}
