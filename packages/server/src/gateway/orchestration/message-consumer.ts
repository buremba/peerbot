import {
  createChildSpan,
  createLogger,
  ErrorCode,
  extractTraceId,
  generateTraceId,
  generateWorkerToken,
  getTraceparent,
  type GuardrailRegistry,
  type MessagePayload,
  OrchestratorError,
  retryWithBackoff,
  runGuardrails,
  SpanStatusCode,
} from "@lobu/core";
import * as Sentry from "@sentry/node";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { platformMetadataString } from "../connections/platform-metadata.js";
import { recordGuardrailTrip } from "../guardrails/audit.js";
import type {
  IMessageQueue,
  QueueJob as SharedQueueJob,
} from "../infrastructure/queue/index.js";
import {
  RunsQueue,
  TERMINAL_DELIVERY_SEND_OPTS,
} from "../infrastructure/queue/index.js";
import { armTurnTimeout, failTurnIfPending } from "./turn-liveness.js";
import {
  type BaseDeploymentManager,
  buildCanonicalConversationKey,
  generateDeploymentName,
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
  private agentSettingsStore?: AgentSettingsStore;
  private guardrailRegistry?: GuardrailRegistry;
  constructor(
    config: OrchestratorConfig,
    deploymentManager: BaseDeploymentManager,
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.queue = new RunsQueue();
  }

  /**
   * Inject guardrail infrastructure post-construction. Called by the
   * Orchestrator after CoreServices has built the registry — the consumer
   * is constructed earlier than CoreServices is wired up, so a setter
   * matches the existing `injectCoreServices` pattern on the orchestrator.
   * Calling with no args is a no-op (guardrails simply don't run).
   */
  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.guardrailRegistry = registry;
    this.agentSettingsStore = settingsStore;
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
    const traceparent = platformMetadataString(
      data?.platformMetadata,
      "traceparent"
    );

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
      // The runs-queue claim sets `job.id = String(runId)` when it
      // dispatches into this handler. Stamp the runId onto the payload so
      // it survives the thread_message_{deployment} hop and reaches the
      // worker — the per-run agent_transcript_snapshot POST needs it to
      // attribute snapshots to the right run (codex P1#1 on PR #865).
      // Best-effort parse; non-numeric ids (legacy direct enqueue paths)
      // leave the field undefined and the snapshot path falls back to
      // skipping the write.
      const parsedRunId = Number(jobId);
      if (Number.isFinite(parsedRunId) && parsedRunId > 0) {
        data.runId = parsedRunId;
      }

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

      // Mint a per-run worker JWT bound to this exact `runs.id` and pass
      // it to the worker via the message payload. The snapshot route uses
      // it to enforce `tokenData.runId === body.runId`, so a worker
      // bearing a same-(org, agent, conv) deployment-lifetime token
      // cannot POST under a different run's slot. Codex round 2 finding
      // A on PR #865. Without a parsed runId (legacy direct-enqueue
      // path) we skip the mint; the snapshot path then declines to write
      // (worker-side runId is undefined and writeSnapshot bails).
      if (data.runId !== undefined) {
        data.runJobToken = generateWorkerToken(
          data.userId,
          effectiveConversationId,
          deploymentName,
          {
            channelId: data.channelId,
            teamId: data.teamId,
            agentId: data.agentId,
            organizationId: data.organizationId,
            platform: data.platform,
            runId: data.runId,
          }
        );
      }

      logger.info(
        `Conversation routing - effectiveConversationId: ${effectiveConversationId}, canonicalKey: ${canonicalConversationKey}, deploymentName: ${deploymentName}`
      );

      // Input-stage guardrails: short-circuit dispatch when an enabled
      // guardrail trips. We surface the trip reason to the user via the
      // `thread_response` queue (same path `trackFailedDeployment` uses)
      // and skip both the worker queue enqueue and the deployment ensure.
      // The trip is captured here but DELIVERED below (outside the fail-open
      // try-catch) so a delivery failure can't be swallowed into dispatch.
      let inputTrip: { reason: string; guardrail: string } | null = null;
      if (
        this.guardrailRegistry &&
        this.agentSettingsStore &&
        data.agentId &&
        data.messageText
      ) {
        try {
          const settings = await this.agentSettingsStore.getSettings(
            data.agentId
          );
          const enabled = settings?.guardrails ?? [];
          if (enabled.length > 0) {
            const outcome = await runGuardrails(
              this.guardrailRegistry,
              "input",
              enabled,
              {
                agentId: data.agentId,
                userId: data.userId,
                message: data.messageText,
                platform: data.platform,
                conversationId: effectiveConversationId,
              }
            );
            if (outcome.tripped) {
              // Resolve org id with a metadata fallback so a trip never
              // silently drops the audit — legacy/test enqueues can omit it.
              let resolvedOrgId = data.organizationId;
              if (!resolvedOrgId && this.agentSettingsStore) {
                try {
                  const md = await this.agentSettingsStore.getMetadata(
                    data.agentId
                  );
                  resolvedOrgId = md?.organizationId;
                } catch (lookupErr) {
                  logger.warn(
                    {
                      agentId: data.agentId,
                      err:
                        lookupErr instanceof Error
                          ? lookupErr.message
                          : String(lookupErr),
                    },
                    "Input guardrail trip: orgId metadata lookup failed (audit may be skipped)"
                  );
                }
              }
              void recordGuardrailTrip({
                organizationId: resolvedOrgId,
                agentId: data.agentId,
                userId: data.userId,
                conversationId: effectiveConversationId,
                stage: "input",
                guardrail: outcome.tripped.guardrail,
                reason: outcome.tripped.reason,
                metadata: outcome.tripped.metadata,
              });
              // Capture the trip; the rejection is DELIVERED below, outside this
              // fail-open try-catch. Delivering here would let a delivery
              // failure be caught by the catch and fall through to dispatch the
              // blocked input — the opposite of what a trip must do.
              inputTrip = {
                reason: outcome.tripped.reason ?? "blocked by policy",
                guardrail: outcome.tripped.guardrail,
              };
            }
          }
        } catch (err) {
          // Fail open on store/registry-level errors — the runner already
          // fail-opens on per-guardrail throws.
          logger.warn(
            {
              agentId: data.agentId,
              err: err instanceof Error ? err.message : String(err),
            },
            "Input guardrail check failed — proceeding without guardrails"
          );
        }
      }

      // Deliver a guardrail rejection OUTSIDE the fail-open try-catch above. A
      // delivery failure here MUST propagate so the `messages` run retries (the
      // trip is deterministic) — it must never be swallowed and fall through to
      // dispatching the blocked input. Routed via `error` (renders end-to-end:
      // SSE error event + CLI exit 1; platforms post `Error: …`). No turn marker
      // is armed for a rejected turn, so the message-queue retry is the backstop.
      if (inputTrip) {
        const responseQueue = "thread_response";
        await this.queue.createQueue(responseQueue);
        await this.queue.send(
          responseQueue,
          {
            messageId: data.messageId,
            userId: data.userId,
            channelId: data.channelId,
            conversationId: data.conversationId,
            platform: data.platform,
            platformMetadata: data.platformMetadata,
            error: `Message rejected: ${inputTrip.reason}`,
            processedMessageIds: [data.messageId],
          },
          TERMINAL_DELIVERY_SEND_OPTS
        );
        logger.info(
          {
            agentId: data.agentId,
            guardrail: inputTrip.guardrail,
            conversationId: effectiveConversationId,
          },
          "Input guardrail tripped — message dropped"
        );
        queueSpan?.setStatus({ code: SpanStatusCode.OK });
        queueSpan?.end();
        return;
      }

      // Arm the turn-liveness marker BEFORE the message is deliverable to the
      // worker. The marker is the durable record that this turn owes the client
      // a terminal event; it is discharged on the worker's reply and otherwise
      // failed (fast path on crash, deadline backstop on hang/pod-death) into a
      // terminal `error`. Arming first closes a race where an already-running
      // worker could reply before the marker exists — the discharge would
      // no-op, then a stale marker would be armed and the sweep would emit a
      // spurious error after a successful turn.
      await armTurnTimeout(this.queue, {
        messageId: data.messageId,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
        userId: data.userId,
        platform: data.platform,
        platformMetadata: data.platformMetadata,
        deploymentName,
        organizationId: data.organizationId,
      });

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

      // Emit the startup-failure notice through the first-writer-wins election
      // (atomic delete-marker + enqueue-error in one tx). This is gated on the
      // marker still being pending: if a still-attached worker raced a real
      // terminal reply (which discharged the marker), this no-ops instead of
      // double-signalling the client. Routes via `error` (renders end-to-end:
      // SSE error event + CLI exit 1; platforms post `Error: …`). If the marker
      // was never armed (arm failed) it also no-ops — logged at arm time.
      await failTurnIfPending(deploymentName, data.messageId, userMessage);
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
