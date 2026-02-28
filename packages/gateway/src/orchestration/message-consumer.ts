import {
  createChildSpan,
  createLogger,
  ErrorCode,
  extractTraceId,
  generateTraceId,
  getTraceparent,
  type ModelProviderModule,
  moduleRegistry,
  OrchestratorError,
  retryWithBackoff,
  SpanStatusCode,
} from "@lobu/core";
import * as Sentry from "@sentry/node";
import { platformAuthRegistry } from "../auth/platform-auth";
import type { ProviderCatalogService } from "../auth/provider-catalog";
import type {
  IMessageQueue,
  QueueJob as SharedQueueJob,
} from "../infrastructure/queue";
import { RedisQueue, type RedisQueueConfig } from "../infrastructure/queue";
import { SystemMessageLimiter } from "../infrastructure/redis/system-message-limiter";
import {
  type BaseDeploymentManager,
  buildCanonicalConversationKey,
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
  private providerModules: ModelProviderModule[];
  private providerCatalogService?: ProviderCatalogService;
  private systemMessageLimiter?: SystemMessageLimiter;

  constructor(
    config: OrchestratorConfig,
    deploymentManager: BaseDeploymentManager
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.providerModules = moduleRegistry.getModelProviderModules();

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
   * Refresh provider modules after module registry initialization.
   */
  setProviderModules(providerModules: ModelProviderModule[]): void {
    this.providerModules = providerModules;
  }

  setProviderCatalogService(service: ProviderCatalogService): void {
    this.providerCatalogService = service;
  }

  private async getEffectiveProviders(
    agentId: string
  ): Promise<ModelProviderModule[]> {
    if (this.providerCatalogService) {
      // When the catalog is active, only use explicitly installed providers.
      // Do NOT fall back to global modules — that would bypass the installable
      // provider system and pick up providers from env vars the user never chose.
      return this.providerCatalogService.getInstalledModules(agentId);
    }
    return this.providerModules;
  }

  private getSystemMessageLimiter(): SystemMessageLimiter {
    if (!this.systemMessageLimiter) {
      // RedisQueue provides a shared ioredis client.
      const redis = this.queue.getRedisClient();
      this.systemMessageLimiter = new SystemMessageLimiter(
        redis,
        "lobu:sysmsg"
      );
    }
    return this.systemMessageLimiter;
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

      // Check if the provider for this agent's model has credentials
      // Only gate if there are registered providers to check
      const agentModel = data.agentOptions?.model as string | undefined;

      // Resolve per-agent installed providers
      const effectiveProviders = await this.getEffectiveProviders(data.agentId);

      // When no providers are installed at all, block early with a setup prompt
      const noProvidersInstalled = effectiveProviders.length === 0;

      if (
        noProvidersInstalled ||
        !(await this.hasAnyProviderAuth(
          data.agentId,
          agentModel,
          effectiveProviders
        ))
      ) {
        logger.info(
          noProvidersInstalled
            ? `Agent ${data.agentId} has no providers installed - sending setup prompt`
            : `Agent ${data.agentId} has no credentials for model ${agentModel || "any"} - sending authentication prompt`
        );

        // Prevent resending the same setup/auth prompt in tight loops.
        // Default: one prompt per (platform, channel, agent) per hour.
        const parsedThrottleSeconds = Number.parseInt(
          process.env.AUTH_PROMPT_DEBOUNCE_SECONDS || "3600",
          10
        );
        const throttleSeconds = Number.isFinite(parsedThrottleSeconds)
          ? parsedThrottleSeconds
          : 3600;

        const parsedLockSeconds = Number.parseInt(
          process.env.AUTH_PROMPT_LOCK_SECONDS || "30",
          10
        );
        const lockSeconds = Number.isFinite(parsedLockSeconds)
          ? parsedLockSeconds
          : 30;

        const dedupeKey = [
          "auth_required",
          data.platform,
          data.channelId,
          data.agentId,
        ].join(":");

        // Reset suppression so each new user message re-triggers the auth prompt
        // (the lock still prevents concurrent sends within lockTtlSeconds)
        await this.queue.getRedisClient().del(`lobu:sysmsg:sent:${dedupeKey}`);

        let didSend = false;
        try {
          didSend = await this.getSystemMessageLimiter().sendOnce(
            dedupeKey,
            async () => {
              // Build list of unauthenticated providers
              const unauthProviders = await this.getUnauthenticatedProviders(
                data.agentId,
                agentModel
              );

              // Use platform auth adapter if available
              const authAdapter = platformAuthRegistry.get(data.platform);
              if (authAdapter) {
                // Platform-specific auth prompt (e.g., WhatsApp numbered list)
                await authAdapter.sendAuthPrompt(
                  data.userId,
                  data.channelId,
                  data.conversationId,
                  unauthProviders,
                  data.platformMetadata
                );
                logger.info(
                  `✅ Sent platform-specific auth prompt for agent ${data.agentId} via ${data.platform} adapter`
                );
                return;
              }

              // Fallback: Send Slack-style ephemeral message for platforms without adapter
              const responseQueue = "thread_response";
              await this.queue.createQueue(responseQueue);
              await this.queue.send(responseQueue, {
                messageId: data.messageId,
                userId: data.userId,
                channelId: data.channelId,
                conversationId: effectiveConversationId,
                platform: data.platform,
                platformMetadata: data.platformMetadata,
                ephemeral: true,
                content: JSON.stringify({
                  blocks: [
                    {
                      type: "section",
                      text: {
                        type: "mrkdwn",
                        text: "🔐 *Setup Required*\n\nYou need to add a model provider to use this bot. Please visit the settings page to configure.",
                      },
                    },
                  ],
                }),
                processedMessageIds: [data.messageId],
              });
              logger.info(
                `✅ Sent Slack-style auth prompt for agent ${data.agentId}`
              );
            },
            {
              sentTtlSeconds: throttleSeconds,
              lockTtlSeconds: lockSeconds,
              failOpen: false,
            }
          );
        } catch (error) {
          // Treat as processed. Without credentials we can't proceed anyway, and retries can spam.
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
              platform: data.platform,
              channelId: data.channelId,
              agentId: data.agentId,
            },
            "Failed to send auth prompt"
          );
          return;
        }

        if (!didSend) {
          logger.info(
            {
              dedupeKey,
              throttleSeconds,
              lockSeconds,
              platform: data.platform,
              channelId: data.channelId,
              agentId: data.agentId,
            },
            "Suppressing repeated auth prompt"
          );
          return; // Don't create worker
        }

        return; // Don't create worker
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

      // 1) Send to thread queue immediately (Redis persists; worker will drain on attach)
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
   * Acquire a Redis-based lock for deployment creation.
   * Prevents concurrent duplicate deployment creation for the same thread.
   */
  private async acquireDeploymentLock(
    deploymentName: string
  ): Promise<boolean> {
    const lockKey = `deployment:lock:${deploymentName}`;
    const redisClient = this.queue.getRedisClient();
    // SET NX with 60s TTL - standard Redis distributed lock
    const result = await redisClient.set(lockKey, "1", "EX", 60, "NX");
    return result === "OK";
  }

  private async releaseDeploymentLock(deploymentName: string): Promise<void> {
    const lockKey = `deployment:lock:${deploymentName}`;
    const redisClient = this.queue.getRedisClient();
    await redisClient.del(lockKey);
  }

  /**
   * Ensure worker deployment exists for a thread
   * Uses shared retry utility with linear backoff + jitter
   * Uses Redis lock to prevent concurrent duplicate deployment creation
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
          // Acquire lock to prevent concurrent deployment creation
          const acquired = await this.acquireDeploymentLock(deploymentName);
          if (!acquired) {
            logger.info(
              { traceId, deploymentName },
              "Another process is creating this deployment, waiting"
            );
            // Wait briefly and re-check - the other process should finish soon
            await new Promise((r) => setTimeout(r, 3000));
            // Verify it was created
            const rechecked = await this.deploymentManager.listDeployments();
            if (rechecked.some((d) => d.deploymentName === deploymentName)) {
              await this.deploymentManager.scaleDeployment(deploymentName, 1);
              logger.info(
                { traceId, deploymentName },
                "Deployment created by other process, scaled up"
              );
              await this.deploymentManager.updateDeploymentActivity(
                deploymentName
              );
              return;
            }
            throw new Error("Deployment lock held but deployment not created");
          }

          try {
            logger.info(
              { traceId, traceparent, conversationId, deploymentName },
              "New thread - creating deployment"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              conversationId,
              dataWithTrace,
              existingDeployments
            );
            logger.info({ traceId, deploymentName }, "Created deployment");
          } finally {
            await this.releaseDeploymentLock(deploymentName);
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
   * Track failed deployment creation for monitoring and potential recovery.
   * Also sends an error response to the user via the thread_response queue.
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
        conversationId: data.conversationId,
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

      const failureReason =
        error instanceof Error ? error.message : String(error);
      const isImagePullFailure =
        /ImagePullBackOff|ErrImagePull|image pull/i.test(failureReason);
      const userMessage = isImagePullFailure
        ? "Worker startup failed due to a Kubernetes image pull error. Please retry after the deployment image/registry configuration is fixed."
        : "Worker startup failed and your request could not be processed. Please retry in a moment.";

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
   * Check if any registered model provider has auth (system key or per-agent credentials)
   */
  private async findProviderForModel(
    model: string,
    providers?: ModelProviderModule[]
  ): Promise<ModelProviderModule | undefined> {
    if (this.providerCatalogService) {
      return this.providerCatalogService.findProviderForModel(model, providers);
    }
    // Fallback when catalog service is not yet injected
    for (const provider of providers || this.providerModules) {
      if (!provider.getModelOptions) continue;
      const options = await provider.getModelOptions("", "");
      if (options.some((opt) => opt.value === model)) {
        return provider;
      }
    }
    return undefined;
  }

  private async hasAnyProviderAuth(
    agentId: string,
    model?: string,
    providers?: ModelProviderModule[]
  ): Promise<boolean> {
    const effectiveProviders = providers || this.providerModules;
    // If a specific model is configured, only check the provider that owns it
    if (model) {
      const provider = await this.findProviderForModel(
        model,
        effectiveProviders
      );
      if (provider) {
        return provider.hasSystemKey() || provider.hasCredentials(agentId);
      }
    }
    // Fallback: check all effective providers
    for (const provider of effectiveProviders) {
      if (provider.hasSystemKey()) return true;
      if (await provider.hasCredentials(agentId)) return true;
    }
    return false;
  }

  /**
   * Get list of providers that have no auth for the given agent
   */
  private async getUnauthenticatedProviders(
    agentId: string,
    model?: string
  ): Promise<Array<{ id: string; name: string }>> {
    // If a specific model is configured, only report the provider that owns it
    if (model) {
      const provider = await this.findProviderForModel(model);
      if (
        provider &&
        !provider.hasSystemKey() &&
        !(await provider.hasCredentials(agentId))
      ) {
        return [
          { id: provider.providerId, name: provider.providerDisplayName },
        ];
      }
      if (provider) return [];
    }
    const unauthProviders: Array<{ id: string; name: string }> = [];
    for (const provider of this.providerModules) {
      if (
        !provider.hasSystemKey() &&
        !(await provider.hasCredentials(agentId))
      ) {
        unauthProviders.push({
          id: provider.providerId,
          name: provider.providerDisplayName,
        });
      }
    }
    return unauthProviders;
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
