/**
 * SSE client for receiving jobs from dispatcher
 */

import { spawn } from "node:child_process";
import {
  createChildSpan,
  createLogger,
  extractTraceId,
  flushTracing,
  SpanStatusCode,
} from "@lobu/core";
import { z } from "zod";
import type { WorkerConfig, WorkerExecutor } from "../core/types";
import { HttpWorkerTransport } from "./gateway-integration";
import { MessageBatcher } from "./message-batcher";
import type { MessagePayload, QueuedMessage } from "./types";

const logger = createLogger("sse-client");

type AbortControllerLike = {
  abort(): void;
  readonly signal: AbortSignal;
};

// --- Pending config change notifications ---

interface ConfigChangeEntry {
  category: string;
  action: string;
  summary: string;
  details?: string[];
}

const pendingConfigNotifications: ConfigChangeEntry[] = [];

/**
 * Returns and clears all pending config change notifications.
 * Called by the worker before building the next prompt.
 */
export function consumePendingConfigNotifications(): ConfigChangeEntry[] {
  if (pendingConfigNotifications.length === 0) return [];
  return pendingConfigNotifications.splice(0);
}

// Zod schemas for runtime validation of SSE event data
const ConnectedEventSchema = z.object({
  deploymentName: z.string(),
});

// PlatformMetadata has known fields plus string index signature
const PlatformMetadataSchema = z
  .object({
    team_id: z.string().optional(),
    channel: z.string().optional(),
    ts: z.string().optional(),
    thread_ts: z.string().optional(),
    files: z.array(z.any()).optional(),
  })
  .and(
    z.record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.any()),
        z.undefined(),
      ])
    )
  );

// AgentOptions has known fields plus arbitrary extra fields (including nested objects)
const AgentOptionsSchema = z
  .object({
    runtime: z.string().optional(),
    model: z.string().optional(),
    maxTokens: z.number().optional(),
    temperature: z.number().optional(),
    allowedTools: z.union([z.string(), z.array(z.string())]).optional(),
    disallowedTools: z.union([z.string(), z.array(z.string())]).optional(),
    timeoutMinutes: z.union([z.number(), z.string()]).optional(),
    // Additional settings passed through from gateway
    networkConfig: z.any().optional(),
    envVars: z.any().optional(),
  })
  .passthrough();

const JobEventSchema = z.object({
  payload: z.object({
    botId: z.string(),
    userId: z.string(),
    agentId: z.string(),
    conversationId: z.string(),
    platform: z.string(),
    channelId: z.string(),
    messageId: z.string(),
    messageText: z.string(),
    platformMetadata: PlatformMetadataSchema,
    agentOptions: AgentOptionsSchema,
    jobId: z.string().optional(),
    teamId: z.string().optional(), // Optional for WhatsApp (top-level) and Slack (in platformMetadata)
  }),
  processedIds: z.array(z.string()).optional(),
});

/**
 * Gateway client for workers - connects to dispatcher via SSE
 * Receives jobs via SSE stream, sends responses via HTTP POST
 */
export class GatewayClient {
  private dispatcherUrl: string;
  private workerToken: string;
  private userId: string;
  private deploymentName: string;
  private isRunning = false;
  private currentWorker: WorkerExecutor | null = null;
  private abortController?: AbortControllerLike;
  private currentJobId?: string;
  private currentTraceId?: string; // Trace ID for end-to-end observability
  private currentTraceparent?: string; // W3C traceparent for distributed tracing
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private messageBatcher: MessageBatcher;
  private eventErrorCount = 0;
  private eventErrorThreshold = 10;
  private httpPort?: number;

  constructor(
    dispatcherUrl: string,
    workerToken: string,
    userId: string,
    deploymentName: string,
    httpPort?: number
  ) {
    this.dispatcherUrl = dispatcherUrl;
    this.workerToken = workerToken;
    this.userId = userId;
    this.deploymentName = deploymentName;
    this.httpPort = httpPort;
    // Get initial traceId from environment (set by deployment)
    this.currentTraceId = process.env.TRACE_ID;

    this.messageBatcher = new MessageBatcher({
      onBatchReady: async (messages) => {
        await this.processBatchedMessages(messages);
      },
    });

    logger.info(
      { traceId: this.currentTraceId, deploymentName },
      "Worker connected"
    );
  }

  async start(): Promise<void> {
    this.isRunning = true;

    while (this.isRunning) {
      try {
        await this.connectAndListen();
        if (!this.isRunning) break;
        await this.handleReconnect();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logger.info("SSE connection aborted");
          break;
        }
        logger.error("SSE connection error:", error);
        if (!this.isRunning) break;
        await this.handleReconnect();
      }
    }
  }

  private async connectAndListen(): Promise<void> {
    // Abort previous controller before creating a new one
    if (this.abortController) {
      this.abortController.abort();
    }
    const abortController =
      new globalThis.AbortController() as AbortControllerLike;
    this.abortController = abortController;
    const streamUrl = this.httpPort
      ? `${this.dispatcherUrl}/worker/stream?httpPort=${this.httpPort}`
      : `${this.dispatcherUrl}/worker/stream`;

    logger.info(
      `Connecting to dispatcher at ${streamUrl} (attempt ${this.reconnectAttempts + 1})`
    );

    const response = await fetch(streamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.workerToken}`,
        Accept: "text/event-stream",
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to connect to dispatcher: ${response.status} ${response.statusText}`
      );
    }

    logger.info("✅ Connected to dispatcher via SSE");
    this.reconnectAttempts = 0;

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error("No response body");
    }

    let buffer = "";

    logger.info("[SSE-CLIENT] 🔄 Starting SSE stream reading loop");

    while (this.isRunning) {
      const { done, value } = await reader.read();

      if (done) {
        logger.info("[SSE-CLIENT] SSE stream ended");
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      logger.debug(
        `[SSE-CLIENT] 📨 Received chunk: ${chunk.substring(0, 200)}`
      );
      buffer += chunk;

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      logger.debug(
        `[SSE-CLIENT] 📊 Parsed ${events.length} events from buffer`
      );

      for (const event of events) {
        if (!event.trim()) continue;

        const lines = event.split("\n");
        let eventType = "message";
        let eventData = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.substring(6).trim();
          } else if (line.startsWith("data:")) {
            eventData = line.substring(5).trim();
          }
        }

        if (eventData) {
          logger.info(`[SSE-CLIENT] 🎯 Processing event type: ${eventType}`);
          // Don't await - fire async to avoid blocking SSE reading loop
          this.handleEvent(eventType, eventData).catch((error) => {
            this.eventErrorCount++;
            logger.error(
              `[SSE-CLIENT] Error handling ${eventType} event (error ${this.eventErrorCount}/${this.eventErrorThreshold}):`,
              error
            );

            // Trigger cleanup if too many errors
            if (this.eventErrorCount >= this.eventErrorThreshold) {
              logger.error(
                `❌ Event error threshold reached (${this.eventErrorCount} errors). Triggering cleanup...`
              );
              this.cleanupOnEventError(eventType).catch((cleanupErr) => {
                logger.error(
                  "Failed to cleanup after event errors:",
                  cleanupErr
                );
              });
            }
          });
        }
      }
    }
  }

  /**
   * Send a quick delivery receipt to the gateway confirming job was received.
   * Fire-and-forget — don't block job processing on the receipt send.
   */
  private sendDeliveryReceipt(jobId: string): void {
    const url = `${this.dispatcherUrl}/worker/response`;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.workerToken}`,
      },
      body: JSON.stringify({ jobId, received: true }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => {
      logger.warn(`Failed to send delivery receipt for job ${jobId}:`, err);
    });
  }

  /**
   * Send a heartbeat ACK back to the gateway so stale cleanup is based on
   * verified inbound worker activity rather than outbound SSE writes.
   */
  private sendHeartbeatAck(): void {
    const url = `${this.dispatcherUrl}/worker/response`;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.workerToken}`,
      },
      body: JSON.stringify({ received: true, heartbeat: true }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => {
      logger.warn("Failed to send heartbeat ACK:", err);
    });
  }

  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("Max reconnection attempts reached, giving up");
      this.isRunning = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 60000);

    logger.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async stop(): Promise<void> {
    try {
      this.isRunning = false;

      if (this.abortController) {
        this.abortController.abort();
      }

      this.messageBatcher.stop();

      if (this.currentWorker) {
        await this.currentWorker.cleanup();
        this.currentWorker = null;
      }

      logger.info("✅ Gateway client stopped");
    } catch (error) {
      logger.error("Error stopping gateway client:", error);
      throw error;
    }
  }

  private async handleEvent(eventType: string, data: string): Promise<void> {
    try {
      if (eventType === "connected") {
        const parsedData = JSON.parse(data);
        const validationResult = ConnectedEventSchema.safeParse(parsedData);

        if (!validationResult.success) {
          logger.error(
            "Invalid connected event data:",
            validationResult.error.format()
          );
          throw new Error(
            `Connected event validation failed: ${validationResult.error.message}`
          );
        }

        const connData = validationResult.data;
        logger.info(
          `Connected to dispatcher for deployment ${connData.deploymentName}`
        );
        return;
      }

      if (eventType === "ping") {
        logger.debug("Received heartbeat ping from dispatcher");
        this.sendHeartbeatAck();
        return;
      }

      if (eventType === "config_changed") {
        logger.info(
          "Received config_changed event from gateway, invalidating session context cache"
        );
        const { invalidateSessionContextCache } = await import(
          "../openclaw/session-context"
        );
        invalidateSessionContextCache();

        // Parse and queue config change notifications for the next prompt
        try {
          const parsed = JSON.parse(data);
          const changes = Array.isArray(parsed?.changes)
            ? (parsed.changes as ConfigChangeEntry[])
            : [];
          if (changes.length > 0) {
            pendingConfigNotifications.push(...changes);
            logger.info(
              `Queued ${changes.length} config change notification(s)`
            );
          }
        } catch {
          // Backward compat: old gateway may send empty or invalid payload
        }
        return;
      }

      if (eventType === "job") {
        try {
          const parsedData = JSON.parse(data);
          const validationResult = JobEventSchema.safeParse(parsedData);

          if (!validationResult.success) {
            logger.error(
              "Invalid job event data:",
              validationResult.error.format()
            );
            logger.debug(`Raw job data: ${data}`);
            throw new Error(
              `Job event validation failed: ${validationResult.error.message}`
            );
          }

          // Send delivery receipt immediately so the gateway knows
          // the job was actually received (not lost to a stale SSE connection).
          // jobId is at the top level of the SSE event (set by job-router),
          // not inside the validated payload.
          const jobId = parsedData.jobId as string | undefined;
          if (jobId) {
            this.sendDeliveryReceipt(jobId);
          }

          // Zod validates structure but passthrough allows extra fields
          // The validated payload matches MessagePayload interface
          await this.handleThreadMessage(validationResult.data.payload);
        } catch (parseError) {
          logger.error(
            `Failed to parse or validate job event data:`,
            parseError
          );
          logger.debug(`Raw job data: ${data}`);
        }
        return;
      }

      logger.warn(
        `[DEBUG] Unknown SSE event type: ${eventType}, data: ${data}`
      );
    } catch (error) {
      logger.error(`Error handling event ${eventType}:`, error);
    }
  }

  private async handleThreadMessage(data: MessagePayload): Promise<void> {
    // Extract traceparent for distributed tracing
    // Prefer platformMetadata.traceparent, fall back to TRACEPARENT env var
    const traceparent =
      (data.platformMetadata?.traceparent as string) || process.env.TRACEPARENT;
    this.currentTraceparent = traceparent;

    // Extract traceId for logging (backwards compatible)
    const traceId =
      extractTraceId(data) || this.currentTraceId || process.env.TRACE_ID;
    this.currentTraceId = traceId;

    const conversationId = data.conversationId;

    if (data.jobId) {
      this.currentJobId = data.jobId;
      // Create child span for job received (linked to parent via traceparent)
      const span = createChildSpan("job_received", traceparent, {
        "lobu.job_id": data.jobId,
        "lobu.message_id": data.messageId,
        "lobu.conversation_id": conversationId,
        "lobu.job_type": data.jobType || "message",
      });
      span?.setStatus({ code: SpanStatusCode.OK });
      span?.end();
      // Flush job_received span immediately
      void flushTracing();
      logger.info(
        {
          traceparent,
          traceId,
          jobId: data.jobId,
          messageId: data.messageId,
          jobType: data.jobType,
        },
        "Job received"
      );
    }

    // No per-user filtering here: deployment names intentionally hash only
    // `platform:channelId:conversationId` (see `generateDeploymentName` in
    // base-deployment-manager.ts) so a channel/thread has ONE shared worker
    // across all posting users. DMs are single-participant, so a check would
    // be dead there too. The WORKER_TOKEN-scoped-to-spawning-user tradeoff
    // for shared channel workers is acknowledged and deferred to per-message
    // JWT minting — gating here would break the core group-bot design.

    // Check job type and dispatch accordingly
    if (data.jobType === "exec") {
      await this.handleExecJob(data);
      return;
    }

    // Default: message job
    const queuedMessage: QueuedMessage = {
      payload: data,
      timestamp: Date.now(),
    };

    await this.messageBatcher.addMessage(queuedMessage);
    logger.info(
      { traceId, messageId: data.messageId, conversationId },
      "Message queued for processing"
    );
  }

  /**
   * Handle exec job - spawn command in sandbox and stream output back
   */
  private async handleExecJob(data: MessagePayload): Promise<void> {
    const { execId, execCommand, execCwd, execEnv, execTimeout } = data;
    const conversationId = data.conversationId;
    const traceId = this.currentTraceId;
    const traceparent = this.currentTraceparent;

    if (!execId || !execCommand) {
      logger.error(
        { traceId, execId },
        "Invalid exec job: missing execId or execCommand"
      );
      return;
    }

    logger.info(
      { traceId, execId, command: execCommand.substring(0, 100) },
      "Executing command in sandbox"
    );

    // Create span for exec execution
    const span = createChildSpan("exec_execution", traceparent, {
      "lobu.exec_id": execId,
      "lobu.command": execCommand.substring(0, 100),
    });

    // Determine working directory
    const workingDir = execCwd || process.env.WORKSPACE_DIR || "/workspace";
    const timeout = execTimeout || 300000; // 5 minutes default

    // Create transport for sending responses back to gateway
    const transport = new HttpWorkerTransport({
      gatewayUrl: this.dispatcherUrl,
      workerToken: this.workerToken,
      userId: data.userId,
      channelId: data.channelId,
      conversationId,
      originalMessageTs: execId,
      teamId: data.teamId || "api",
      platform: data.platform,
      platformMetadata: data.platformMetadata,
    });

    let completed = false;

    try {
      // Spawn the command
      const proc = spawn("sh", ["-c", execCommand], {
        cwd: workingDir,
        env: { ...process.env, ...execEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Setup timeout
      const timeoutId = setTimeout(() => {
        if (!completed) {
          logger.warn(
            { traceId, execId },
            "Exec timeout reached, killing process"
          );
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!completed) {
              proc.kill("SIGKILL");
            }
          }, 5000);
        }
      }, timeout);

      // Stream stdout
      proc.stdout?.on("data", (chunk: Buffer) => {
        const content = chunk.toString();
        transport.sendExecOutput(execId, "stdout", content).catch((err) => {
          logger.error(
            { traceId, execId, error: err },
            "Failed to send stdout"
          );
        });
      });

      // Stream stderr
      proc.stderr?.on("data", (chunk: Buffer) => {
        const content = chunk.toString();
        transport.sendExecOutput(execId, "stderr", content).catch((err) => {
          logger.error(
            { traceId, execId, error: err },
            "Failed to send stderr"
          );
        });
      });

      // Wait for process to complete
      const exitCode = await new Promise<number>((resolve, reject) => {
        proc.on("close", (code) => {
          completed = true;
          clearTimeout(timeoutId);
          resolve(code ?? 0);
        });

        proc.on("error", (error) => {
          completed = true;
          clearTimeout(timeoutId);
          reject(error);
        });
      });

      // Send completion
      await transport.sendExecComplete(execId, exitCode);

      span?.setAttribute("lobu.exit_code", exitCode);
      span?.setStatus({ code: SpanStatusCode.OK });
      span?.end();
      await flushTracing();

      logger.info({ traceId, execId, exitCode }, "Exec completed");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Send error
      await transport.sendExecError(execId, errorMessage).catch((err) => {
        logger.error(
          { traceId, execId, error: err },
          "Failed to send exec error"
        );
      });

      span?.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      span?.end();
      await flushTracing();

      logger.error({ traceId, execId, error: errorMessage }, "Exec failed");
    } finally {
      this.currentJobId = undefined;
    }
  }

  private async processBatchedMessages(
    messages: QueuedMessage[]
  ): Promise<void> {
    if (messages.length === 0) return;

    if (messages.length === 1) {
      const singleMessage = messages[0];
      if (singleMessage) {
        await this.processSingleMessage(singleMessage, [
          singleMessage.payload.messageId,
        ]);
      }
      return;
    }

    logger.info(`Batching ${messages.length} messages for combined processing`);

    const firstMessage = messages[0];
    if (!firstMessage) return;

    const combinedPrompt = messages
      .map((msg, index) => `Message ${index + 1}: ${msg.payload.messageText}`)
      .join("\n\n");

    const batchedMessage: QueuedMessage = {
      timestamp: firstMessage.timestamp,
      payload: {
        ...firstMessage.payload,
        messageText: combinedPrompt,
        agentOptions: firstMessage.payload.agentOptions,
      },
    };

    const processedIds = messages
      .map((m) => m.payload.messageId)
      .filter(Boolean);
    await this.processSingleMessage(batchedMessage, processedIds);
  }

  private async processSingleMessage(
    message: QueuedMessage,
    processedIds?: string[]
  ): Promise<void> {
    // Get traceparent for distributed tracing
    const traceparent =
      (message.payload.platformMetadata?.traceparent as string) ||
      this.currentTraceparent ||
      process.env.TRACEPARENT;

    const traceId =
      extractTraceId(message.payload) ||
      this.currentTraceId ||
      process.env.TRACE_ID;

    const conversationId = message.payload.conversationId;

    // Create child span for agent execution (linked to parent via traceparent)
    const span = createChildSpan("agent_execution", traceparent, {
      "lobu.message_id": message.payload.messageId,
      "lobu.conversation_id": conversationId,
      "lobu.user_id": message.payload.userId,
      "lobu.model": message.payload.agentOptions?.model || "default",
    });

    try {
      if (!process.env.USER_ID) {
        logger.warn(
          `USER_ID not set in environment, using userId from payload: ${message.payload.userId}`
        );
        process.env.USER_ID = message.payload.userId;
      }

      const workerConfig = this.payloadToWorkerConfig(message.payload);

      logger.info(
        {
          traceparent,
          traceId,
          messageId: message.payload.messageId,
          model: message.payload.agentOptions?.model,
        },
        "Agent starting"
      );

      // Worker will decide whether to continue session based on workspace state
      const { OpenClawWorker } = await import("../openclaw/worker");
      this.currentWorker = new OpenClawWorker(workerConfig);

      const workerTransport = this.currentWorker.getWorkerTransport();

      if (workerTransport && workerTransport instanceof HttpWorkerTransport) {
        if (this.currentJobId) {
          workerTransport.setJobId(this.currentJobId);
        }

        // Set processedMessageIds directly on the integration instance
        workerTransport.processedMessageIds =
          processedIds && processedIds.length > 0
            ? processedIds
            : message.payload.messageId
              ? [message.payload.messageId]
              : [];
      }

      await this.currentWorker.execute();

      this.currentJobId = undefined;

      // Reset error count on successful message processing
      this.eventErrorCount = 0;

      // End span with success
      span?.setStatus({ code: SpanStatusCode.OK });
      span?.end();
      // Flush traces immediately to ensure spans are exported before worker scales down
      await flushTracing();
      logger.info(
        {
          traceparent,
          messageId: message.payload.messageId,
          conversationId,
        },
        "Agent completed"
      );
    } catch (error) {
      // End span with error
      span?.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span?.end();
      // Flush traces on error too
      await flushTracing();
      logger.error(
        {
          traceparent,
          messageId: message.payload.messageId,
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Agent failed"
      );

      const workerTransport = this.currentWorker?.getWorkerTransport();
      if (workerTransport) {
        try {
          const enhancedError =
            error instanceof Error ? error : new Error(String(error));
          await workerTransport.signalError(enhancedError);
        } catch (errorSendError) {
          logger.error(
            { traceId, error: errorSendError },
            "Failed to send error to dispatcher"
          );
        }
      }

      throw error;
    } finally {
      if (this.currentWorker) {
        try {
          await this.currentWorker.cleanup();
        } catch (cleanupError) {
          logger.error(
            { traceId, error: cleanupError },
            "Error during worker cleanup"
          );
        }
        this.currentWorker = null;
      }
    }
  }

  private payloadToWorkerConfig(payload: MessagePayload): WorkerConfig {
    const conversationId = payload.conversationId || "default";
    const platformMetadata = payload.platformMetadata;

    const agentOptions = {
      ...(payload.agentOptions || {}),
      ...(payload.agentOptions?.allowedTools
        ? { allowedTools: payload.agentOptions.allowedTools }
        : {}),
      ...(payload.agentOptions?.disallowedTools
        ? { disallowedTools: payload.agentOptions.disallowedTools }
        : {}),
      ...(payload.agentOptions?.timeoutMinutes
        ? { timeoutMinutes: payload.agentOptions.timeoutMinutes }
        : {}),
    };

    return {
      sessionKey: `session-${conversationId}`,
      userId: payload.userId,
      agentId: payload.agentId,
      channelId: payload.channelId,
      conversationId,
      userPrompt: Buffer.from(payload.messageText).toString("base64"),
      responseChannel: String(
        platformMetadata.responseChannel || payload.channelId
      ),
      responseId: String(platformMetadata.responseId || payload.messageId),
      botResponseId: platformMetadata.botResponseId
        ? String(platformMetadata.botResponseId)
        : undefined,
      // Check both payload.teamId (WhatsApp) and platformMetadata.teamId (Slack)
      teamId:
        (payload.teamId ?? platformMetadata.teamId)
          ? String(payload.teamId ?? platformMetadata.teamId)
          : undefined,
      platform: payload.platform,
      platformMetadata: platformMetadata, // Include full platformMetadata for files and other metadata
      agentOptions: JSON.stringify(agentOptions),
      workspace: {
        baseDirectory: process.env.WORKSPACE_DIR || "/workspace",
      },
    };
  }

  /**
   * Cleanup resources after event handling errors exceed threshold
   */
  private async cleanupOnEventError(eventType: string): Promise<void> {
    logger.warn(
      `Cleaning up after ${this.eventErrorCount} event handling errors (last: ${eventType})`
    );

    try {
      // Clean up current worker if it exists
      if (this.currentWorker) {
        logger.info("Cleaning up current worker due to event errors");
        try {
          await this.currentWorker.cleanup();
        } catch (cleanupError) {
          logger.error("Worker cleanup failed:", cleanupError);
        }
        this.currentWorker = null;
      }

      // Reset current job
      if (this.currentJobId) {
        logger.info(`Clearing stuck job: ${this.currentJobId}`);
        this.currentJobId = undefined;
      }

      // Abort SSE connection to trigger reconnect
      if (this.abortController) {
        logger.info("Aborting SSE connection to trigger reconnect");
        this.abortController.abort();
        this.abortController = undefined;
      }

      // Reset error count after cleanup
      this.eventErrorCount = 0;

      logger.info("Event error cleanup completed, will reconnect");
    } catch (cleanupError) {
      logger.error("Fatal error during event error cleanup:", cleanupError);
      // Last resort: stop the client entirely
      this.isRunning = false;
    }
  }

  isHealthy(): boolean {
    return this.isRunning && !this.messageBatcher.isCurrentlyProcessing();
  }

  getStatus(): {
    isRunning: boolean;
    isProcessing: boolean;
    userId: string;
    deploymentName: string;
    pendingMessages: number;
  } {
    return {
      isRunning: this.isRunning,
      isProcessing: this.messageBatcher.isCurrentlyProcessing(),
      userId: this.userId,
      deploymentName: this.deploymentName,
      pendingMessages: this.messageBatcher.getPendingCount(),
    };
  }
}
