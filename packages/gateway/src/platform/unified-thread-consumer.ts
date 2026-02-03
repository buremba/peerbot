/**
 * Unified thread response consumer.
 * Single consumer that routes responses to platform-specific renderers
 * via the PlatformRegistry, eliminating duplicate queue filtering logic.
 */

import { createLogger } from "@peerbot/core";
import type {
  IMessageQueue,
  QueueJob,
  ThreadResponsePayload,
} from "../infrastructure/queue";
import type { PlatformRegistry } from "../platform";
import type { ResponseRenderer } from "./response-renderer";

const logger = createLogger("unified-thread-consumer");

/**
 * Unified consumer for thread_response queue.
 * Routes responses to the appropriate platform adapter based on payload.platform field.
 */
export class UnifiedThreadResponseConsumer {
  private isRunning = false;

  constructor(
    private queue: IMessageQueue,
    private platformRegistry: PlatformRegistry
  ) {}

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

      this.isRunning = true;
      logger.info("Unified thread response consumer started");
    } catch (error) {
      logger.error("Failed to start unified thread response consumer:", error);
      throw error;
    }
  }

  /**
   * Stop the consumer.
   */
  async stop(): Promise<void> {
    this.isRunning = false;
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

    if (!data || !data.messageId) {
      logger.error(`Invalid thread response data: ${JSON.stringify(data)}`);
      return;
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

    try {
      await this.routeToRenderer(renderer, data, sessionKey);
    } catch (error) {
      logger.error(
        `Error processing thread response for ${platformName}:`,
        error
      );
      // Let queue handle retry logic
      throw error;
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
    // Handle ephemeral messages (OAuth/auth flows)
    if (data.ephemeral && data.content && renderer.handleEphemeral) {
      await renderer.handleEphemeral(data);
      return;
    }

    // Handle status updates (heartbeat with elapsed time)
    if (data.statusUpdate && renderer.handleStatusUpdate) {
      await renderer.handleStatusUpdate(data);
      return;
    }

    // Handle streaming delta
    if (data.delta && renderer.handleDelta) {
      await renderer.handleDelta(data, sessionKey);
      // Early return if no error - delta processing is complete
      if (!data.error) {
        return;
      }
    }

    // Handle error
    if (data.error) {
      await renderer.handleError(data, sessionKey);
      // Also complete session on error
      await renderer.handleCompletion(data, sessionKey);
      return;
    }

    // Handle completion
    if (data.processedMessageIds?.length) {
      await renderer.handleCompletion(data, sessionKey);
    }
  }

  /**
   * Check if consumer is healthy.
   */
  isHealthy(): boolean {
    return this.isRunning;
  }
}
