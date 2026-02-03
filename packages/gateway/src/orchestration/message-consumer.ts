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
} from "@peerbot/core";
import * as Sentry from "@sentry/node";
import type { ClaudeCredentialStore } from "../auth/claude/credential-store";
import { platformAuthRegistry } from "../auth/platform-auth";
import type {
  IMessageQueue,
  QueueJob as SharedQueueJob,
} from "../infrastructure/queue";
import { RedisQueue, type RedisQueueConfig } from "../infrastructure/queue";
import {
  type BaseDeploymentManager,
  generateDeploymentName,
  type MessagePayload,
  type OrchestratorConfig,
} from "./base-deployment-manager";

const logger = createLogger("orchestrator");

export class MessageConsumer {
  private queue: IMessageQueue;
  private deploymentManager: BaseDeploymentManager;
  private config: OrchestratorConfig;
  private isRunning = false;
  private credentialStore?: ClaudeCredentialStore;
  private systemApiKey?: string;

  constructor(
    config: OrchestratorConfig,
    deploymentManager: BaseDeploymentManager,
    credentialStore?: ClaudeCredentialStore,
    systemApiKey?: string
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.credentialStore = credentialStore;
    this.systemApiKey = systemApiKey;

    // Parse Redis connection string
    const url = new URL(config.queues.connectionString);
    if (url.protocol !== "redis:") {
      throw new Error(
        `Unsupported queue protocol: ${url.protocol}. Only redis:// is supported.`
      );
    }

    const queueConfig: RedisQueueConfig = {
      host: url.hostname,
      port: Number.parseInt(url.port, 10) || 6379,
      password: url.password || undefined,
      db: url.pathname ? Number.parseInt(url.pathname.slice(1), 10) : 0,
      maxRetriesPerRequest: 3,
    };

    this.queue = new RedisQueue(queueConfig);
  }

  async start(): Promise<void> {
    try {
      await this.queue.start();
      this.isRunning = true;

      // Create the messages queue if it doesn't exist
      await this.queue.createQueue("messages");
      logger.info("✅ Created/verified messages queue");

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

      logger.info("✅ Queue consumer started - listening for messages");
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
      "peerbot.trace_id": traceId,
      "peerbot.job_id": jobId,
      "peerbot.user_id": data?.userId || "unknown",
      "peerbot.thread_id": data?.threadId || "unknown",
    });

    // Get traceparent to pass to worker (for further context propagation)
    const childTraceparent = getTraceparent(queueSpan) || traceparent;

    logger.info(
      {
        traceparent,
        traceId,
        jobId,
        userId: data?.userId,
        threadId: data?.threadId,
      },
      "Processing job with trace context"
    );

    try {
      // Check if agent has credentials or if system API key is available
      // Credentials are stored by agentId (space-level), not userId
      if (this.credentialStore && !this.systemApiKey) {
        const hasCredentials = await this.credentialStore.hasCredentials(
          data.agentId
        );

        if (!hasCredentials) {
          logger.info(
            `Agent ${data.agentId} has no credentials - sending authentication prompt`
          );

          // Use platform auth adapter if available
          const authAdapter = platformAuthRegistry.get(data.platform);
          if (authAdapter) {
            // Platform-specific auth prompt (e.g., WhatsApp numbered list)
            await authAdapter.sendAuthPrompt(
              data.userId,
              data.channelId,
              data.threadId,
              [{ id: "claude", name: "Claude" }],
              data.platformMetadata
            );
            logger.info(
              `✅ Sent platform-specific auth prompt for agent ${data.agentId} via ${data.platform} adapter`
            );
          } else {
            // Fallback: Send Slack-style ephemeral message for platforms without adapter
            const responseQueue = "thread_response";
            await this.queue.createQueue(responseQueue);
            await this.queue.send(responseQueue, {
              messageId: data.messageId,
              userId: data.userId,
              channelId: data.channelId,
              threadId: data.threadId,
              platform: data.platform,
              platformMetadata: data.platformMetadata,
              ephemeral: true,
              content: JSON.stringify({
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: "🔐 *Authentication Required*\n\nYou need to login with your Claude account to use this bot. Please visit the app home tab to authenticate.",
                    },
                  },
                  {
                    type: "actions",
                    elements: [
                      {
                        type: "button",
                        text: {
                          type: "plain_text",
                          text: "Login with Claude",
                        },
                        style: "primary",
                        action_id: "claude_auth_start",
                        value: "start_auth",
                      },
                    ],
                  },
                ],
              }),
              processedMessageIds: [data.messageId],
            });
            logger.info(
              `✅ Sent Slack-style auth prompt for agent ${data.agentId}`
            );
          }

          return; // Don't create worker
        }
      }

      // CRITICAL: For consistent worker naming, threadId must be the thread_ts (root message timestamp)
      // Platform adapters (e.g., Slack) must ensure threadId is the root thread ID, NOT individual message timestamps
      const effectiveThreadId = data.threadId;

      const deploymentName = generateDeploymentName(
        data.userId,
        effectiveThreadId
      );

      logger.info(
        `Thread routing - effectiveThreadId: ${effectiveThreadId}, deploymentName: ${deploymentName}`
      );

      // 1) Send to thread queue immediately (Redis persists; worker will drain on attach)
      await Sentry.startSpan(
        {
          name: "orchestrator.send_to_worker_queue",
          op: "orchestrator.message_routing",
          attributes: {
            "user.id": data.userId,
            "thread.id": data.threadId,
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
        traceId,
        childTraceparent
      ).catch((bgError) => {
        // Capture error for monitoring and alerting
        Sentry.captureException(bgError, {
          tags: {
            component: "deployment-creation",
            deploymentName,
            userId: data.userId,
            threadId: data.threadId,
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
            threadId: data.threadId,
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

      // Re-throw for Redis retry handling
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
        retryDelay: this.config.queues.retryDelay,
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
        `✅ Sent message to thread queue ${threadQueueName} for thread ${data.threadId}, jobId: ${jobId}`
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
   * Ensure worker deployment exists for a thread
   * Uses shared retry utility with linear backoff + jitter
   */
  private async ensureWorkerExists(
    deploymentName: string,
    data: MessagePayload,
    traceId: string,
    traceparent?: string
  ): Promise<void> {
    return retryWithBackoff(
      async () => {
        // Check if this is truly a new thread by looking for existing deployment
        const existingDeployments =
          await this.deploymentManager.listDeployments();
        const isNewThread = !existingDeployments.some(
          (d) => d.deploymentName === deploymentName
        );

        // Ensure traceparent is in platformMetadata for worker deployment
        const dataWithTrace: MessagePayload = {
          ...data,
          platformMetadata: {
            ...data.platformMetadata,
            traceparent: traceparent || data.platformMetadata?.traceparent,
          },
        };

        if (isNewThread) {
          logger.info(
            { traceId, traceparent, threadId: data.threadId, deploymentName },
            "New thread - creating deployment"
          );
          await this.deploymentManager.createWorkerDeployment(
            data.userId,
            data.threadId,
            dataWithTrace
          );
          logger.info({ traceId, deploymentName }, "Created deployment");
        } else {
          logger.info(
            { traceId, threadId: data.threadId, deploymentName },
            "Existing thread - ensuring worker exists"
          );
          try {
            await this.deploymentManager.scaleDeployment(deploymentName, 1);
            logger.info(
              { traceId, deploymentName },
              "Scaled existing worker to 1"
            );
          } catch (_error) {
            logger.info(
              { traceId, threadId: data.threadId, deploymentName },
              "Worker doesn't exist, creating it"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              data.threadId,
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
   * Track failed deployment creation for monitoring and potential recovery
   */
  private async trackFailedDeployment(
    deploymentName: string,
    data: MessagePayload,
    error: unknown
  ): Promise<void> {
    try {
      const failureKey = `deployment:failed:${deploymentName}`;
      const failureData = {
        deploymentName,
        userId: data.userId,
        threadId: data.threadId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
        queueName: `thread_message_${deploymentName}`,
      };

      // Store in Redis with 24h TTL for monitoring dashboards
      // This allows ops to detect stuck queues and manually intervene
      const redisClient = this.queue.getRedisClient();
      await redisClient.setex(
        failureKey,
        86400, // 24 hours
        JSON.stringify(failureData)
      );

      logger.info(
        `Tracked deployment failure in Redis: ${failureKey} (TTL: 24h)`
      );
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
