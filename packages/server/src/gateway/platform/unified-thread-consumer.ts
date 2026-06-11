/**
 * Unified thread response consumer.
 * Single consumer that routes responses to platform-specific renderers
 * via the PlatformRegistry, eliminating duplicate queue filtering logic.
 */

import { createChildSpan, createLogger } from "@lobu/core";
import type { ChatResponseBridge } from "../connections/chat-response-bridge.js";
import type {
  IMessageQueue,
  QueueJob,
  ThreadResponsePayload,
} from "../infrastructure/queue/index.js";
import type { PlatformRegistry } from "../platform.js";
import type { SseManager } from "../services/sse-manager.js";
import type { ResponseRenderer } from "./response-renderer.js";

const logger = createLogger("unified-thread-consumer");

/**
 * Unified consumer for thread_response queue.
 * Routes responses to the appropriate platform adapter based on payload.platform field.
 */
export class UnifiedThreadResponseConsumer {
  private chatResponseBridge?: ChatResponseBridge;

  constructor(
    private queue: IMessageQueue,
    private platformRegistry: PlatformRegistry,
    private sseManager: SseManager
  ) {}

  setChatResponseBridge(bridge: ChatResponseBridge): void {
    this.chatResponseBridge = bridge;
  }

  /**
   * Start consuming thread_response messages.
   */
  async start(): Promise<void> {
    try {
      await this.queue.start();
      await this.queue.createQueue("thread_response");

      await this.queue.work(
        "thread_response",
        this.handleThreadResponse.bind(this)
      );

      logger.debug("Unified thread response consumer started");
    } catch (error) {
      logger.error("Failed to start unified thread response consumer:", error);
      throw error;
    }
  }

  /**
   * Stop the consumer.
   */
  async stop(): Promise<void> {
    await this.queue.stop();
    logger.info("Unified thread response consumer stopped");
  }

  /**
   * Handle a thread response job by routing to the appropriate platform renderer.
   */
  private async handleThreadResponse(
    job: QueueJob<ThreadResponsePayload>
  ): Promise<void> {
    const data = job.data;

    if (!data?.messageId) {
      logger.error(`Invalid thread response data: ${JSON.stringify(data)}`);
      return;
    }

    // Create child span for response processing (linked to original trace)
    const traceparent = data.platformMetadata?.traceparent as
      | string
      | undefined;
    const span = createChildSpan("response_delivery", traceparent, {
      "lobu.message_id": data.messageId,
      "lobu.user_id": data.userId,
      "lobu.platform": data.platform || data.teamId || "unknown",
    });

    try {
      // Check if this response belongs to a Chat SDK connection — handle before legacy routing.
      // If a Chat SDK connectionId is present but this gateway instance does not manage it,
      // fail the job so another instance can retry instead of silently completing an undelivered reply.
      const chatConnectionId = data.platformMetadata?.connectionId as string | undefined;
      if (this.chatResponseBridge?.canHandle(data)) {
        const sessionKey = `${data.userId}:${data.originalMessageId || data.messageId}`;
        await this.routeToRenderer(this.chatResponseBridge, data, sessionKey);
        return;
      }
      if (chatConnectionId) {
        throw new Error(
          `Chat SDK connection ${chatConnectionId} is not managed by this gateway instance`
        );
      }

      // Use platform field, fall back to teamId
      const platformName = data.platform || data.teamId;
      if (!platformName) {
        logger.warn(
          `Missing platform in thread response for message ${data.messageId}, skipping`
        );
        return;
      }

      // Get platform adapter from registry
      const platform = this.platformRegistry.get(platformName);
      if (!platform) {
        logger.warn(
          `No platform adapter registered for: ${platformName}, skipping message ${data.messageId}`
        );
        return;
      }

      // Get renderer from platform
      const renderer = platform.getResponseRenderer?.();
      if (!renderer) {
        logger.warn(
          `Platform ${platformName} does not provide a response renderer, skipping message ${data.messageId}`
        );
        return;
      }

      // Create session key for tracking
      const sessionKey = `${data.userId}:${data.originalMessageId || data.messageId}`;

      logger.info(
        `Processing thread response for platform=${platformName}, message=${data.messageId}, session=${sessionKey}`
      );

      await this.routeToRenderer(renderer, data, sessionKey);
    } catch (error) {
      logger.error(
        `Error processing thread response for message ${data.messageId}:`,
        error
      );
      throw error;
    } finally {
      span?.end();
    }
  }

  /**
   * Route the payload to the appropriate renderer method.
   */
  private async routeToRenderer(
    renderer: ResponseRenderer,
    data: ThreadResponsePayload,
    sessionKey: string
  ): Promise<void> {
    const cliSessionId =
      typeof data.platformMetadata?.sessionId === "string"
        ? (data.platformMetadata.sessionId as string)
        : null;

    // Owner-routing for API/SSE TERMINAL delivery (success completion OR
    // error). The SseManager is per-pod and in-memory, so a terminal event
    // only reaches the client if THIS pod holds the SSE connection. Under N>1
    // replicas the client's SSE (pod S, pinned by ClientIP affinity) and the
    // pod that produced this row can differ — so a row claimed by a non-owning
    // pod must re-queue until pod S claims it. This mirrors the platform
    // canHandle re-queue (handleThreadResponse) and also fixes the pre-existing
    // cross-pod success-completion drop on the API path.
    //
    // Scoped to TERMINAL API rows only: platform replies have their own
    // connectionId owner-routing, and deltas stay best-effort (un-gated) to
    // avoid per-delta re-queue churn. The re-queue relies on the owning pod
    // eventually winning the SKIP-LOCKED claim; terminal sends use a short
    // fixed retryDelay + raised retryLimit (see TERMINAL_DELIVERY_SEND_OPTS) so
    // the window covers both cross-pod hand-off and the client's POST→connect
    // gap. Sufficient at the small replica counts we run; a durable
    // SSE-session→pod registry with targeted delivery is the future hardening
    // for very large N.
    // Detect API rows by platform OR teamId: the worker's HTTP response carries
    // `teamId: "api"` but omits `platform`, while gateway-generated rows (e.g.
    // turn-liveness errors) set `platform: "api"`. Matching only `platform`
    // would leave NORMAL worker success/error rows un-gated → cross-pod drop.
    // Exclude Chat SDK rows: routeToRenderer is also reached via the
    // chatResponseBridge path, which already owner-routes by `connectionId`
    // (canHandle re-queues to the managing instance). Gating those on SSE
    // ownership too could re-queue a reply that was ready to deliver. The SSE
    // owner-gate is only for pure API/SSE rows, which never carry a connectionId.
    const isApiRow =
      (data.platform || data.teamId) === "api" &&
      !data.platformMetadata?.connectionId;
    if (isApiRow) {
      const isTerminal = !!(
        data.error ||
        (data.processedMessageIds && data.processedMessageIds.length)
      );
      // Interaction cards (ask_user question, tool-approval, link-button) are
      // pushed to the browser's SSE socket, which lives on exactly one pod.
      // Like terminal rows they must be owner-routed: a non-owning pod
      // re-queues so the pod holding the SSE connection (pinned by ClientIP
      // affinity) delivers the card. Without this the card lands in a pod-local
      // SseManager the browser is not connected to and the user never sees it,
      // leaving the ask_user/tool-approval turn hung. The card-bearing rows are
      // enqueued with `customEvent.requireSseOwner` set (see api/platform.ts)
      // and the same raised-retry send opts as terminal rows so the re-queue
      // window covers the cross-pod hand-off and the browser's POST→connect gap.
      const requiresSseOwner =
        isTerminal || data.customEvent?.requireSseOwner === true;
      const sseKey =
        (data.platformMetadata?.sessionId as string) || data.conversationId;
      if (
        requiresSseOwner &&
        sseKey &&
        !this.sseManager.hasActiveConnection(sseKey)
      ) {
        throw new Error(
          `API SSE session ${sseKey} not owned by this gateway instance; re-queueing for owner delivery`
        );
      }
    }

    if (data.customEvent) {
      const eventPayload = {
        ...data.customEvent.data,
        timestamp: data.timestamp,
        messageId: data.messageId,
      };
      this.sseManager.broadcast(
        data.conversationId,
        data.customEvent.name,
        eventPayload
      );
      if (cliSessionId) {
        this.sseManager.broadcast(
          cliSessionId,
          data.customEvent.name,
          eventPayload
        );
      }

      if (
        !data.ephemeral &&
        !data.statusUpdate &&
        !data.delta &&
        !data.error &&
        !data.processedMessageIds?.length
      ) {
        return;
      }
    }

    // Handle ephemeral messages (OAuth/auth flows)
    if (data.ephemeral && data.content && renderer.handleEphemeral) {
      if (cliSessionId) {
        this.sseManager.broadcast(cliSessionId, "ephemeral", {
          type: "ephemeral",
          content: data.content,
          messageId: data.messageId,
          timestamp: data.timestamp,
        });
      }
      await renderer.handleEphemeral(data);
      return;
    }

    // Handle status updates (heartbeat with elapsed time)
    if (data.statusUpdate && renderer.handleStatusUpdate) {
      if (cliSessionId) {
        this.sseManager.broadcast(cliSessionId, "status", {
          type: "status",
          status: data.statusUpdate,
          messageId: data.messageId,
          timestamp: data.timestamp,
        });
      }
      await renderer.handleStatusUpdate(data);
      return;
    }

    // Handle streaming delta
    if (data.delta && renderer.handleDelta) {
      if (cliSessionId) {
        this.sseManager.broadcast(cliSessionId, "output", {
          type: "delta",
          content: data.delta,
          timestamp: data.timestamp,
          messageId: data.messageId,
        });
      }
      await renderer.handleDelta(data, sessionKey);
      // Early return if no error - delta processing is complete
      if (!data.error) {
        return;
      }
    }

    // Handle error
    if (data.error) {
      if (cliSessionId) {
        this.sseManager.broadcast(cliSessionId, "error", {
          type: "error",
          error: data.error,
          messageId: data.messageId,
          timestamp: data.timestamp,
        });
      }
      await renderer.handleError(data, sessionKey);
      // Also complete session on error
      if (cliSessionId) {
        this.sseManager.broadcast(cliSessionId, "complete", {
          type: "complete",
          messageId: data.messageId,
          processedMessageIds: data.processedMessageIds,
          timestamp: data.timestamp,
        });
      }
      await renderer.handleCompletion(data, sessionKey);
      return;
    }

    // Handle completion
    if (data.processedMessageIds?.length) {
      if (cliSessionId) {
        this.sseManager.broadcast(cliSessionId, "complete", {
          type: "complete",
          messageId: data.messageId,
          processedMessageIds: data.processedMessageIds,
          timestamp: data.timestamp,
        });
      }
      await renderer.handleCompletion(data, sessionKey);
    }
  }

}
