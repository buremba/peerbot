import * as Sentry from "@sentry/node";
import type { BaseDeploymentManager } from "./base/BaseDeploymentManager";
import { ErrorCode, type OrchestratorConfig, OrchestratorError } from "./types";
import { createLogger, createMessageQueue, type MessageQueue, type MessagePayload } from "@peerbot/shared";

const logger = createLogger("orchestrator");

export class QueueConsumer {
  private messageQueue: MessageQueue;
  private deploymentManager: BaseDeploymentManager;
  private config: OrchestratorConfig;
  private isRunning = false;

  constructor(
    config: OrchestratorConfig,
    deploymentManager: BaseDeploymentManager
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;

    this.messageQueue = createMessageQueue({
      provider: "postgresql",
      connectionString: config.queues.connectionString,
      retryLimit: config.queues.retryLimit,
      retryDelay: config.queues.retryDelay,
      expireInSeconds: config.queues.expireInSeconds,
      retentionDays: 7,
      deleteAfterDays: 30,
    });
  }

  async start(): Promise<void> {
    try {
      await this.messageQueue.start();
      this.isRunning = true;

      // Create the messages queue if it doesn't exist
      await this.messageQueue.createQueue("messages");
      logger.info("✅ Created/verified messages queue");

      // Subscribe to the single messages queue for all messages
      await this.messageQueue.work("messages", async (payload: MessagePayload) => {
        return await Sentry.startSpan(
          {
            name: "orchestrator.process_queue_job",
            op: "orchestrator.queue_processing",
            attributes: {
              "user.id": payload.userId,
              "thread.id": payload.threadId,
            },
          },
          async () => {
            logger.info("=== MESSAGE QUEUE PAYLOAD RECEIVED ===");
            logger.info("Message payload:", JSON.stringify(payload, null, 2));
            return this.handleMessage(payload);
          }
        );
      });

      logger.info("✅ Queue consumer started - listening for messages");

      // Start background cleanup task
      this.startCleanupTask();
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
    await this.messageQueue.stop();
  }

  /**
   * Handle all messages - creates deployment for new threads or routes to existing thread queues
   */
  private async handleMessage(payload: MessagePayload): Promise<void> {
    logger.info("=== ORCHESTRATOR RECEIVED MESSAGE ===");

    logger.info("Processing message payload:", JSON.stringify(payload, null, 2));

    logger.info(
      `Processing message for user ${payload.userId}, thread ${payload.threadId}`
    );

    try {
      // CRITICAL: For consistent worker naming, always use the targetThreadId if available
      // This ensures ALL messages in a Slack thread use the SAME worker
      // Thread ID must be the thread_ts (root message timestamp), NOT individual message timestamps!
      const effectiveThreadId =
        payload.routingMetadata?.targetThreadId || payload.threadId;

      // Create deployment name - MUST be consistent for entire thread
      // DO NOT use message timestamps - that creates multiple workers per thread!
      const shortThreadId = effectiveThreadId.replace(".", "-").slice(-10); // Last 10 chars, replace dot with dash
      const shortUserId = payload.userId.toLowerCase().slice(0, 8); // First 8 chars of user ID
      const deploymentName = `peerbot-worker-${shortUserId}-${shortThreadId}`;

      logger.info(
        `Thread routing - effectiveThreadId: ${effectiveThreadId}, deploymentName: ${deploymentName}`
      );

      // 1) Send to thread queue immediately (message queue persists; worker will drain on attach)
      await Sentry.startSpan(
        {
          name: "orchestrator.send_to_worker_queue",
          op: "orchestrator.message_routing",
          attributes: {
            "user.id": payload.userId,
            "thread.id": payload.threadId,
            "deployment.name": deploymentName,
          },
        },
        async () => {
          await this.sendToWorkerQueue(payload, deploymentName);
        }
      );

      logger.info(`✅ Enqueued message to thread queue for ${deploymentName}`);

      // 2) Ensure worker exists in the background (don’t block queue send)
      (async () => {
        try {
          // Check if this is truly a new thread by looking for existing deployment
          const existingDeployments =
            await this.deploymentManager.listDeployments();
          const isNewThread = !existingDeployments.some(
            (d) => d.deploymentName === deploymentName
          );

          if (isNewThread) {
            logger.info(
              `New thread ${data.threadId} - creating deployment ${deploymentName}`
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              data.threadId,
              data
            );
            logger.info(`✅ Created deployment: ${deploymentName}`);
          } else {
            logger.info(
              `Existing thread ${data.threadId} - ensuring worker ${deploymentName} exists`
            );
            try {
              await this.deploymentManager.scaleDeployment(deploymentName, 1);
              logger.info(`✅ Scaled existing worker ${deploymentName} to 1`);
            } catch (_error) {
              logger.info(
                `Worker ${deploymentName} doesn't exist, creating it for thread ${data.threadId}`
              );
              await this.deploymentManager.createWorkerDeployment(
                data.userId,
                data.threadId,
                data
              );
              logger.info(`✅ Created worker: ${deploymentName}`);
            }
          }

          // Update deployment activity annotation for simplified tracking
          await this.deploymentManager.updateDeploymentActivity(deploymentName);
        } catch (bgError) {
          logger.warn(
            `⚠️  Background ensure worker failed for ${deploymentName}:`,
            bgError instanceof Error ? bgError.message : String(bgError)
          );
        }
      })();

      logger.info(`✅ Message job ${jobId} queued successfully`);
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`❌ Message job ${jobId} failed:`, error);

      // Re-throw for pgboss retry handling
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
    payload: MessagePayload,
    deploymentName: string
  ): Promise<void> {
    try {
      // Create thread-specific queue name: thread_message_[deploymentid]
      const threadQueueName = `thread_message_${deploymentName}`;

      // Create the thread-specific queue if it doesn't exist
      await this.messageQueue.createQueue(threadQueueName);

      // Send message to thread-specific queue
      const jobId = await this.messageQueue.send(
        threadQueueName,
        {
          ...payload,
          // Add routing metadata
          routingMetadata: {
            deploymentName,
            threadId: payload.threadId,
            userId: payload.userId,
            timestamp: new Date().toISOString(),
          },
        },
        {
          expireInSeconds: this.config.queues.expireInSeconds,
          retryLimit: this.config.queues.retryLimit,
          retryDelay: this.config.queues.retryDelay,
          priority: 10, // Thread messages have high priority
        }
      );

      if (!jobId) {
        throw new Error(
          `Message queue send() returned null/undefined for queue: ${threadQueueName}`
        );
      }

      logger.info(
        `✅ Sent message to thread queue ${threadQueueName} for thread ${payload.threadId}, jobId: ${jobId}`
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
   * Start background cleanup task for inactive threads
   */
  private startCleanupTask(): void {
    const cleanupInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(cleanupInterval);
        return;
      }

      logger.info("🧹 Running worker deployment cleanup task...");
      try {
        await this.deploymentManager.reconcileDeployments();
      } catch (error) {
        logger.error("Error during cleanup task:", error);
      }
    }, 60 * 1000); // Run every minute
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<any> {
    try {
      const stats = await this.messageQueue.getQueueStats("messages");
      return {
        messages: stats,
        isRunning: this.isRunning,
      };
    } catch (error) {
      logger.error("Failed to get queue stats:", error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
