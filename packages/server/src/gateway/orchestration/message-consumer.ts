import {
  createChildSpan,
  createLogger,
  ErrorCode,
  extractTraceId,
  generateTraceId,
  getTraceparent,
  OrchestratorError,
  retryWithBackoff,
  SpanStatusCode,
} from "@lobu/core";
import * as Sentry from "@sentry/node";
import type {
  IMessageQueue,
  QueueJob as SharedQueueJob,
} from "../infrastructure/queue/index.js";
import { RunsQueue } from "../infrastructure/queue/index.js";
import {
  type BaseDeploymentManager,
  buildCanonicalConversationKey,
  generateDeploymentName,
  type MessagePayload,
  type OrchestratorConfig,
} from "./base-deployment-manager.js";

const logger = createLogger("orchestrator");

export class MessageConsumer {
  private queue: IMessageQueue;
  private deploymentManager: BaseDeploymentManager;
  private config: OrchestratorConfig;
  private isRunning = false;
  /**
   * Per-process deployment-creation lock. The embedded-only server
   * has a single MessageConsumer instance per process, so an in-memory Map
   * is sufficient for the "two consecutive messages for the same thread
   * race to create the deployment" guard. The Phase-9 gateway no longer
   * has cross-process workers.
   */
  private deploymentLocks = new Map<string, Promise<unknown>>();
  constructor(
    config: OrchestratorConfig,
    deploymentManager: BaseDeploymentManager,
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.queue = new RunsQueue();
  }

  async start(): Promise<void> {
    try {
      await this.queue.start();
      this.isRunning = true;

      // Create the messages queue if it doesn't exist
      await this.queue.createQueue("messages");
      logger.debug("Created/verified messages queue");

      // Subscribe to the single messages queue for all messages
      await this.queue.work(
        "messages",
        async (job: SharedQueueJob<MessagePayload>) => {
          return await Sentry.startSpan(
            {
              name: "orchestrator.process_queue_job",
              op: "orchestrator.queue_processing",
              attributes: {
                "job.id": job?.id || "unknown",
              },
            },
            async () => {
              return this.handleMessage(job);
            }
          );
        }
      );

      logger.debug("Queue consumer started");
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to start queue consumer: ${error instanceof Error ? error.message : String(error)}`,
        { error },
        true
      );
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.queue.stop();
  }

  /**
   * Handle all messages - creates deployment for new threads or routes to existing thread queues
   */
  private async handleMessage(
    job: SharedQueueJob<MessagePayload>
  ): Promise<void> {
    const data = job?.data;
    const jobId = job?.id || "unknown";

    // Extract traceparent for distributed tracing (from message ingestion)
    const traceparent = data?.platformMetadata?.traceparent as
      | string
      | undefined;

    // Extract or generate trace ID for logging (backwards compatible)
    const traceId =
      extractTraceId(data) || generateTraceId(data?.messageId || jobId);

    // Add traceId to Sentry scope for correlation
    Sentry.getCurrentScope().setTag("traceId", traceId);

    // Create child span for queue processing (linked to message_received span)
    const queueSpan = createChildSpan("queue_processing", traceparent, {
      "lobu.trace_id": traceId,
      "lobu.job_id": jobId,
      "lobu.user_id": data?.userId || "unknown",
      "lobu.conversation_id": data?.conversationId || "unknown",
    });

    // Get traceparent to pass to worker (for further context propagation)
    const childTraceparent = getTraceparent(queueSpan) || traceparent;

    logger.info(
      {
        traceparent,
        traceId,
        jobId,
        userId: data?.userId,
        conversationId: data?.conversationId,
      },
      "Processing job with trace context"
    );

    try {
      // CRITICAL: For consistent worker naming, conversationId must be the root conversation ID
      // (e.g., Slack thread root ts), not individual message timestamps.
      const effectiveConversationId = data.conversationId;
      if (!effectiveConversationId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "conversationId is required for message routing",
          { messageId: data.messageId, userId: data.userId },
          true
        );
      }

      const canonicalConversationKey = buildCanonicalConversationKey({
        platform: data.platform,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
      });
      const deploymentName = generateDeploymentName({
        userId: data.userId,
        platform: data.platform,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
      });

      logger.info(
        `Conversation routing - effectiveConversationId: ${effectiveConversationId}, canonicalKey: ${canonicalConversationKey}, deploymentName: ${deploymentName}`
      );

      // TODO(#254): input-stage guardrail hook. When a GuardrailRegistry is
      // injected here, call runGuardrails("input", registry, settings.guardrails, ctx)
      // before sendToWorkerQueue. On trip: skip dispatch, surface trip.reason
      // to the user via the response bridge. Lookup of settings.guardrails
      // requires threading an AgentConfigStore into MessageConsumer; deferred
      // to the PR that registers the first real input guardrail (#251).
      // 1) Send to thread queue immediately (queue persists; worker will drain on attach)
      await Sentry.startSpan(
        {
          name: "orchestrator.send_to_worker_queue",
          op: "orchestrator.message_routing",
          attributes: {
            "user.id": data.userId,
            "conversation.id": effectiveConversationId || "unknown",
            "deployment.name": deploymentName,
          },
        },
        async () => {
          await this.sendToWorkerQueue(data, deploymentName);
        }
      );

      logger.info(
        { traceId, traceparent: childTraceparent, deploymentName },
        "Enqueued message to thread queue"
      );

      // 2) Ensure worker exists in the background (don't block queue send)
      // Pass traceparent for propagation to worker deployment
      this.ensureWorkerExists(
        deploymentName,
        data,
        effectiveConversationId,
        traceId,
        childTraceparent
      ).catch((bgError) => {
        // Capture error for monitoring and alerting
        Sentry.captureException(bgError, {
          tags: {
            component: "deployment-creation",
            deploymentName,
            userId: data.userId,
            conversationId: effectiveConversationId,
          },
          level: "error",
        });

        logger.error(
          {
            traceId,
            error: bgError instanceof Error ? bgError.message : String(bgError),
            stack: bgError instanceof Error ? bgError.stack : undefined,
            deploymentName,
            userId: data.userId,
            conversationId: effectiveConversationId,
          },
          "Critical: Background worker creation failed. Messages are queued but worker unavailable."
        );

        // Track failed deployments for monitoring and potential retry
        this.trackFailedDeployment(deploymentName, data, bgError).catch(
          (trackError) => {
            logger.error("Failed to track deployment failure:", trackError);
          }
        );
      });

      queueSpan?.setStatus({ code: SpanStatusCode.OK });
      queueSpan?.end();

      logger.info({ traceId, jobId }, "Message job queued successfully");
    } catch (error) {
      queueSpan?.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      queueSpan?.end();
      Sentry.captureException(error);
      logger.error({ traceId, jobId, error }, "Message job failed");

      // Re-throw for queue retry handling
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to process message job: ${error instanceof Error ? error.message : String(error)}`,
        { jobId, data, error },
        true
      );
    }
  }

  /**
   * Send message to worker queue for the worker to consume
   */
  private async sendToWorkerQueue(
    data: MessagePayload,
    deploymentName: string
  ): Promise<void> {
    try {
      // Create thread-specific queue name: thread_message_[deploymentid]
      const threadQueueName = `thread_message_${deploymentName}`;

      // Create the thread-specific queue if it doesn't exist
      await this.queue.createQueue(threadQueueName);

      // Send message to thread-specific queue
      const jobId = await this.queue.send(threadQueueName, data, {
        expireInSeconds: this.config.queues.expireInSeconds,
        retryLimit: this.config.queues.retryLimit,
        retryDelay: 2, // 2 seconds — fast retry for stale connection recovery
        priority: 10, // Thread messages have high priority
      });

      if (!jobId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          `queue.send() returned null/undefined for queue: ${threadQueueName}`,
          { threadQueueName, deploymentName },
          true
        );
      }

      logger.info(
        `✅ Sent message to thread queue ${threadQueueName} for conversation ${data.conversationId}, jobId: ${jobId}`
      );
    } catch (error) {
      logger.error(`❌ [ERROR] sendToWorkerQueue failed:`, error);
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to send message to thread queue: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, data, error },
        true
      );
    }
  }

  /**
   * Acquire a per-process lock for deployment creation. Prevents two
   * concurrent message handlers from racing to create the same deployment.
   * In embedded mode the gateway is single-process; an in-memory Map is
   * the right primitive here (TTL is not needed because the lock is held
   * for the duration of the awaited create call and released in finally).
   */
  private acquireDeploymentLock(deploymentName: string): boolean {
    if (this.deploymentLocks.has(deploymentName)) return false;
    // We store a placeholder; the caller wraps the create in a try/finally
    // and `releaseDeploymentLock` removes the entry once done.
    this.deploymentLocks.set(deploymentName, Promise.resolve());
    return true;
  }

  private releaseDeploymentLock(deploymentName: string): void {
    this.deploymentLocks.delete(deploymentName);
  }

  /**
   * Ensure worker deployment exists for a thread
   * Uses shared retry utility with linear backoff + jitter
   * Uses an advisory lock to prevent concurrent duplicate deployment creation
   */
  private async ensureWorkerExists(
    deploymentName: string,
    data: MessagePayload,
    conversationId: string,
    traceId: string,
    traceparent?: string
  ): Promise<void> {
    return retryWithBackoff(
      async () => {
        // Ensure traceparent is in platformMetadata for worker deployment
        const dataWithTrace: MessagePayload = {
          ...data,
          platformMetadata: {
            ...data.platformMetadata,
            traceparent: traceparent || data.platformMetadata?.traceparent,
          },
        };

        // Check if this is truly a new thread by looking for existing deployment
        const existingDeployments =
          await this.deploymentManager.listDeployments();
        const isNewThread = !existingDeployments.some(
          (d) => d.deploymentName === deploymentName
        );

        if (isNewThread) {
          const acquired = this.acquireDeploymentLock(deploymentName);
          if (!acquired) {
            logger.info(
              { traceId, deploymentName },
              "Another handler is creating this deployment, waiting"
            );
            await new Promise((r) => setTimeout(r, 3000));
            const rechecked = await this.deploymentManager.listDeployments();
            if (rechecked.some((d) => d.deploymentName === deploymentName)) {
              await this.deploymentManager.scaleDeployment(deploymentName, 1);
              logger.info(
                { traceId, deploymentName },
                "Deployment created by other handler, scaled up"
              );
              await this.deploymentManager.updateDeploymentActivity(
                deploymentName
              );
              return;
            }
            throw new Error("Deployment lock held but deployment not created");
          }

          try {
            // Re-check after acquiring lock — another handler in this process
            // may have completed creation between our initial check and the
            // lock acquisition.
            const recheckAfterLock =
              await this.deploymentManager.listDeployments();
            if (
              recheckAfterLock.some((d) => d.deploymentName === deploymentName)
            ) {
              logger.info(
                { traceId, deploymentName },
                "Deployment already created by another handler after lock acquired"
              );
              await this.deploymentManager.scaleDeployment(deploymentName, 1);
              await this.deploymentManager.updateDeploymentActivity(
                deploymentName
              );
              return;
            }

            logger.info(
              { traceId, traceparent, conversationId, deploymentName },
              "New thread - creating deployment"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              conversationId,
              dataWithTrace,
              recheckAfterLock
            );
            logger.info({ traceId, deploymentName }, "Created deployment");
          } finally {
            this.releaseDeploymentLock(deploymentName);
          }
        } else {
          logger.info(
            { traceId, conversationId, deploymentName },
            "Existing thread - ensuring worker exists"
          );
          // Sync network config domains to grant store (picks up settings changes)
          await this.deploymentManager.syncNetworkConfigGrants(dataWithTrace);
          try {
            await this.deploymentManager.scaleDeployment(deploymentName, 1);
            logger.info(
              { traceId, deploymentName },
              "Scaled existing worker to 1"
            );
          } catch {
            logger.info(
              { traceId, conversationId, deploymentName },
              "Worker doesn't exist, creating it"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              conversationId,
              dataWithTrace
            );
            logger.info({ traceId, deploymentName }, "Created worker");
          }
        }

        // Update deployment activity annotation for simplified tracking
        await this.deploymentManager.updateDeploymentActivity(deploymentName);

        logger.info({ traceId, deploymentName }, "Worker is ready");
      },
      {
        maxRetries: 3,
        baseDelay: 2000,
        strategy: "linear",
        jitter: true,
        onRetry: (attempt, error) => {
          logger.warn(
            { traceId, deploymentName, attempt, maxAttempts: 3 },
            `Retry attempt failed: ${error.message}`
          );
        },
      }
    );
  }

  /**
   * Track failed deployment creation. Sends the error response to the user
   * via the thread_response queue; structured logs cover ops visibility.
   */
  private async trackFailedDeployment(
    deploymentName: string,
    data: MessagePayload,
    error: unknown
  ): Promise<void> {
    try {
      logger.error(
        {
          deploymentName,
          userId: data.userId,
          conversationId: data.conversationId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          queueName: `thread_message_${deploymentName}`,
        },
        "Deployment creation failed"
      );

      const userMessage =
        "Worker startup failed and your request could not be processed. Please retry in a moment.";

      // Notify user that their message could not be processed
      try {
        const responseQueue = "thread_response";
        await this.queue.createQueue(responseQueue);
        await this.queue.send(responseQueue, {
          messageId: data.messageId,
          userId: data.userId,
          channelId: data.channelId,
          conversationId: data.conversationId,
          platform: data.platform,
          platformMetadata: data.platformMetadata,
          content: userMessage,
          processedMessageIds: [data.messageId],
        });
      } catch (notifyError) {
        logger.error("Failed to send error notification to user:", notifyError);
      }
    } catch (trackError) {
      // Don't fail the main flow if tracking fails
      logger.error("Failed to track deployment failure:", trackError);
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    messages?: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    };
    isRunning: boolean;
    error?: string;
  }> {
    try {
      const stats = await this.queue.getQueueStats("messages");
      return {
        messages: stats,
        isRunning: this.isRunning,
      };
    } catch (error) {
      logger.error("Failed to get queue stats:", error);
      return {
        isRunning: this.isRunning,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
