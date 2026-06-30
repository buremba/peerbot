import {
	ConversationOwnedElsewhereError,
	createChildSpan,
	createLogger,
	ErrorCode,
	extractTraceId,
	generateTraceId,
	generateWorkerToken,
	getErrorMessage,
	getTraceparent,
	type GuardrailRegistry,
	type MessagePayload,
	OrchestratorError,
	retryWithBackoff,
	runGuardrailInstances,
	SpanStatusCode,
} from "@lobu/core";
import {
  enabledInlineGuardrails,
  resolveAgentGuardrails,
} from "../guardrails/aggregator.js";
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
  buildCanonicalConversationKey,
  type DeploymentManager,
  generateDeploymentName,
  type OrchestratorConfig,
} from "./deployment-manager.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";
import { resolveAgentRuntimeSelection } from "../../lobu/stores/environment-store.js";
import { getDb } from "../../db/client.js";

const logger = createLogger("orchestrator");

/**
 * Mint the per-run worker JWT the worker uses as its PRIMARY gateway auth
 * (`session-runner`: `runJobToken || WORKER_TOKEN`). Extracted as a pure,
 * exported function so the claim set is exercised by a regression test that
 * pins parity with the consumer requirements — the #1274 P0 (this mint
 * omitted `connectionId`, so every chat `ask_user` 500'd at
 * `assertRoutableInteraction`) shipped precisely because no test drove the
 * mint code. Any claim a downstream consumer reads off the verified worker
 * token (connectionId, source, platform, teamId, agentId, organizationId,
 * runId, …) MUST be set here; the test asserts that so the next omitted
 * claim fails red instead of in prod.
 *
 * Returns `undefined` when `runId` is absent (legacy direct-enqueue path):
 * the worker then falls back to the deployment-lifetime WORKER_TOKEN and the
 * snapshot route declines to write.
 */
/**
 * Internal admin tools the org's builder agent may call from its worker. The
 * grant rides the per-run worker token (set in `resolveBuilderAdminTools` only
 * for the system agent on an owner/admin-initiated turn) and is enforced
 * tool-by-tool at the execute gate. Keep this in lockstep with the gate's
 * exact-name check in `tools/execute.ts`.
 */
export const BUILDER_ADMIN_TOOLS = [
  "manage_agents",
  "manage_connections",
  "manage_feeds",
  "manage_watchers",
  "manage_schedules",
  "manage_entity",
] as const;

/**
 * Decide whether THIS turn's worker token should carry the builder admin-tool
 * grant. Returns the allowlist only when the target agent is the org's system
 * agent (`organization.system_agent_id`) AND the human sending the message is an
 * org owner/admin. Fails closed (returns undefined) on any lookup error — a
 * missing grant just means the model can't see/call the admin tools, never an
 * over-grant. One indexed query (org PK + member join); runs per turn.
 */
export async function resolveBuilderAdminTools(args: {
  agentId?: string;
  organizationId?: string;
  userId?: string;
}): Promise<string[] | undefined> {
  if (!args.agentId || !args.organizationId || !args.userId) return undefined;
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT o.system_agent_id, m.role
      FROM organization o
      LEFT JOIN "member" m
        ON m."organizationId" = o.id AND m."userId" = ${args.userId}
      WHERE o.id = ${args.organizationId}
      LIMIT 1
    `) as unknown as Array<{ system_agent_id: string | null; role: string | null }>;
    const row = rows[0];
    if (!row || row.system_agent_id !== args.agentId) return undefined;
    if (row.role !== "owner" && row.role !== "admin") return undefined;
    return [...BUILDER_ADMIN_TOOLS];
  } catch (err) {
    logger.warn(
      { err, organizationId: args.organizationId, agentId: args.agentId },
      "resolveBuilderAdminTools failed; minting without admin grant"
    );
    return undefined;
  }
}

export function buildRunJobToken(args: {
  userId: string;
  conversationId: string;
  deploymentName: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  platform?: string;
  platformMetadata?: Record<string, unknown>;
  runId?: number;
  /**
   * Per-turn binding for token refresh: the turn-timeout marker is armed with
   * this SAME messageId, so the refresh gate requires a live marker for THIS
   * turn (deploymentName:messageId), not merely any live turn on the deployment.
   */
  messageId?: string;
  /**
   * Builder admin-tool allowlist for this turn (system agent + owner/admin
   * initiator only). Carried in the encrypted token and enforced at the
   * execute gate; undefined for every normal agent/turn.
   */
  adminTools?: string[];
  /**
   * Resolved runtime provider + environment for this agent (from its selected
   * Environment). Stamped into the token so the generic runtime route picks the
   * provider + vault credential. Undefined → deployment-wide LOBU_RUNTIME_PROVIDER.
   */
  runtimeProviderId?: string;
  environmentId?: string;
  runtimeExplicit?: boolean;
}): string | undefined {
  if (args.runId === undefined) return undefined;
  return generateWorkerToken(
    args.userId,
    args.conversationId,
    args.deploymentName,
    {
      adminTools: args.adminTools,
      // PRIMARY auth → shared routing claims (channelId, teamId, platform,
      // agentId, organizationId, connectionId, source) are minted via
      // `buildWorkerTokenClaims`, kept in lockstep with the deployment-token
      // mint. connectionId in particular MUST be present or interaction posts
      // hit `assertRoutableInteraction` and every ask_user 500s (#1274).
      ...buildWorkerTokenClaims(args),
      // Per-run-token-specific claims.
      runId: args.runId,
      messageId: args.messageId,
    }
  );
}

export class MessageConsumer {
  private queue: IMessageQueue;
  private deploymentManager: DeploymentManager;
  private config: OrchestratorConfig;
  private isRunning = false;
  /**
   * Per-process deployment-creation lock. The embedded-only server
   * has a single MessageConsumer instance per process, so an in-memory Set
   * is sufficient for the "two consecutive messages for the same thread
   * race to create the deployment" guard. The cross-pod guard is the PG
   * advisory lock in DeploymentManager — this Set is pod-local only.
   */
  private deploymentLocks = new Set<string>();
  private agentSettingsStore?: AgentSettingsStore;
  private guardrailRegistry?: GuardrailRegistry;
  constructor(
    config: OrchestratorConfig,
    deploymentManager: DeploymentManager,
    // Test seam: the production path always uses the real Postgres-backed
    // RunsQueue. Tests inject a fake so `handleMessage` can be driven without a
    // database. Not a configuration knob — no caller passes this outside tests.
    queue: IMessageQueue = new RunsQueue(),
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.queue = queue;
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
        `Failed to start queue consumer: ${getErrorMessage(error)}`,
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
      // Builder admin-tool grant: only the org's system agent, only when the
      // human driving this turn is an owner/admin. Fails closed.
      const adminTools = await resolveBuilderAdminTools({
        agentId: data.agentId,
        organizationId: data.organizationId,
        userId: data.userId,
      });

      // Resolve the agent's selected execution environment → runtime provider +
      // credential, stamped into the per-run token. Falls back to the
      // deployment-wide selector when no environment is pinned.
      const runtimeSelection = await resolveAgentRuntimeSelection(
        data.agentId,
        data.organizationId
      );

      data.runJobToken = buildRunJobToken({
        userId: data.userId,
        conversationId: effectiveConversationId,
        deploymentName,
        channelId: data.channelId,
        teamId: data.teamId,
        agentId: data.agentId,
        organizationId: data.organizationId,
        platform: data.platform,
        platformMetadata: data.platformMetadata,
        runId: data.runId,
        // Per-turn binding for token refresh: the turn-timeout marker is armed
        // below with this SAME messageId, so the refresh gate can require a live
        // marker for THIS turn (deploymentName:messageId) rather than any live
        // turn on the deployment.
        messageId: data.messageId,
        adminTools,
        runtimeProviderId: runtimeSelection.runtimeProviderId,
        environmentId: runtimeSelection.environmentId,
        runtimeExplicit: runtimeSelection.explicit,
      });

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
          const resolved = resolveAgentGuardrails(
            settings ?? { guardrails: [] },
            (settings?.skillsConfig?.skills ?? []).filter((s) => s.enabled),
            this.guardrailRegistry,
            { inline: enabledInlineGuardrails(settings) }
          );
          const list = resolved.byStage.input;
          if (list.length > 0) {
            const outcome = await runGuardrailInstances("input", list, {
              agentId: data.agentId,
              userId: data.userId,
              message: data.messageText,
              platform: data.platform,
              conversationId: effectiveConversationId,
            });
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
              err: getErrorMessage(err),
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
        // Cross-pod handled-elsewhere signal: another replica won the
        // per-conversation lock and is running this turn to completion. This is
        // NOT a failure on this pod — drop silently. No Sentry capture, no
        // Critical log, no `trackFailedDeployment` (which would surface a
        // spurious "Worker startup failed" to the user and, via
        // `failTurnIfPending`, race the winning pod's reply to terminalize the
        // shared turn marker). The winner discharges the marker on its reply.
        if (bgError instanceof ConversationOwnedElsewhereError) {
          logger.info(
            {
              traceId,
              deploymentName,
              userId: data.userId,
              conversationId: effectiveConversationId,
            },
            "Conversation owned by another replica — dropping this pod's spawn (handled elsewhere)"
          );
          return;
        }

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
            error: getErrorMessage(bgError),
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
        message: getErrorMessage(error),
      });
      queueSpan?.end();
      Sentry.captureException(error);
      logger.error({ traceId, jobId, error }, "Message job failed");

      // Re-throw for queue retry handling
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to process message job: ${getErrorMessage(error)}`,
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
        `Failed to send message to thread queue: ${getErrorMessage(error)}`,
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
    this.deploymentLocks.add(deploymentName);
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
            // Poll for the other handler's create to land: one 3s-spaced
            // recheck, same total wait as the prior hand-rolled sleep (the
            // added up-front check is a cheap read that only lets us scale
            // up sooner when the create has already finished). Exhausting
            // the poll throws to the outer retryWithBackoff, exactly like
            // the old single-recheck throw did.
            await retryWithBackoff(
              async () => {
                const rechecked =
                  await this.deploymentManager.listDeployments();
                if (
                  !rechecked.some((d) => d.deploymentName === deploymentName)
                ) {
                  throw new Error(
                    "Deployment lock held but deployment not created"
                  );
                }
              },
              {
                maxRetries: 1,
                baseDelay: 3000,
                strategy: "linear",
                // Quiet retry — the "waiting" log above already covers it.
                onRetry: () => {},
              }
            );
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
        // Don't burn retries (~14s) on the cross-pod handled-elsewhere signal:
        // the winning replica holds the session-level advisory lock for the
        // whole worker subprocess lifetime, so a retry here can never win.
        // Abort immediately and let the `.catch` above drop silently.
        shouldRetry: (error) =>
          !(error instanceof ConversationOwnedElsewhereError),
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
          error: getErrorMessage(error),
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
        error: getErrorMessage(error),
      };
    }
  }
}
