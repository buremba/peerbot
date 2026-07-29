import {
	AgentErrorCode,
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
import { withDeploymentTurnLock } from "../infrastructure/deployment-turn-lock.js";
import {
  armTurnTimeout,
  failTurnIfPending,
  hasLiveTurnForDeployment,
} from "./turn-liveness.js";
import { recordAgentRunInput } from "./agent-run-input.js";
import {
  buildCanonicalConversationKey,
  type DeploymentManager,
  generateDeploymentName,
  type OrchestratorConfig,
} from "./deployment-manager.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";
import { resolvePinnedSelection } from "../../lobu/stores/sandbox-store.js";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity.js";
import { resolveActiveChatConnectionTenant } from "../../lobu/stores/connections-projection.js";
import { getDb } from "../../db/client.js";
import { threadIdFromApiConversationId } from "../services/api-conversation-id.js";
import {
  classifyConversation,
  isWatcherConversationId,
  upsertConversation,
} from "../services/conversations-store.js";
import { resolveAgentToolingDeclaration } from "../agent-tooling/resolver.js";

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
  "manage_behaviors",
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
  /**
   * Platform this turn originated from. On a chat platform (slack/telegram/…)
   * `userId` is the PLATFORM user id (e.g. Slack `U…`), NOT a Lobu user id, so
   * the member lookup below would never match and an org owner driving the
   * builder from Slack would silently lose the admin grant. We resolve the
   * platform id → linked Lobu user first. Absent / "api" → `userId` is already
   * the session's Lobu user id and is used directly.
   */
  platform?: string;
  /**
   * Workspace team id for identity lookup (Slack `T…` from the event). Prefer
   * this over routing keys; see call site for platformMetadata.teamId.
   */
  teamId?: string;
  /**
   * Optional second team key to try when the first miss (e.g. Slack connection
   * `external_tenant_id` = Grid enterprise `E…` while the event carries a
   * workspace `T…`). Only an exact row under that key counts — never a
   * cross-team unique-user collapse.
   */
  alternateTeamId?: string;
}): Promise<string[] | undefined> {
  if (!args.agentId || !args.organizationId || !args.userId) return undefined;
  try {
    // Map a platform user id to its linked Lobu user before the member join.
    // resolveChatUserIdentity is workspace-scoped (keyed on the PK
    // platform+team_id+platform_user_id) and returns null when the id isn't
    // linked, so a grant is only ever made for a linked, known user.
    const platform = args.platform;
    const isChatPlatform =
      platform != null && platform !== "api" && platform !== "";
    let lobuUserId: string | null | undefined = isChatPlatform
      ? await resolveChatUserIdentity(platform, args.teamId, args.userId)
      : args.userId;
    if (
      !lobuUserId &&
      isChatPlatform &&
      args.alternateTeamId &&
      args.alternateTeamId !== args.teamId
    ) {
      lobuUserId = await resolveChatUserIdentity(
        platform,
        args.alternateTeamId,
        args.userId,
      );
    }
    if (!lobuUserId) return undefined;
    const sql = getDb();
    const rows = (await sql`
      SELECT o.system_agent_id, m.role
      FROM organization o
      LEFT JOIN "member" m
        ON m."organizationId" = o.id AND m."userId" = ${lobuUserId}
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

/**
 * The two team keys the Builder admin grant is looked up under, derived from a
 * message payload. Extracted from the dispatch path so the
 * metadata→tenant→grant composition is testable on its own — the pieces
 * (identity link, tenant store, grant) each had coverage, but the wiring
 * between them did not, and that is precisely where a runtime-id-vs-slug
 * mismatch silently disables the grant for BYO connections.
 *
 * - `teamId`: the real workspace/enterprise id from `platformMetadata` (T… /
 *   E…). `routingTeamId` is a ROUTING key (platform name for DMs, channel id
 *   for groups — see message-handler-bridge `payloadTeamId`), NOT a workspace
 *   id, so it is only the fallback that keeps non-Slack callers working.
 * - `alternateTeamId`: Grid enterprise installs key connections + some identity
 *   rows on E… while events carry the workspace T…. The connection's tenant is
 *   offered as an exact second key only — never a global U… collapse — and is
 *   omitted when it would duplicate `teamId`.
 *
 * Fails OPEN on the alternate only (undefined ⇒ the grant just falls back to
 * the primary key); it never invents a team, so it cannot over-grant.
 */
export async function resolveGrantTeamKeys(args: {
  platform?: string;
  organizationId?: string;
  routingTeamId?: string;
  platformMetadata?: Record<string, unknown>;
}): Promise<{ teamId?: string; alternateTeamId?: string }> {
  const teamId =
    platformMetadataString(args.platformMetadata, "teamId") ?? args.routingTeamId;
  const connectionId = platformMetadataString(
    args.platformMetadata,
    "connectionId",
  );
  if (args.platform !== "slack" || !args.organizationId || !connectionId) {
    return { teamId };
  }
  try {
    // Scoped + fail-closed in the store (see `resolveActiveChatConnectionTenant`):
    // org + runtime connection id + connector, and active chat rows only, so a
    // reused slug or a paused install can never supply the alternate team for
    // this privilege grant.
    const tenant = await resolveActiveChatConnectionTenant(
      getDb(),
      args.organizationId,
      connectionId,
      "slack",
    );
    return {
      teamId,
      alternateTeamId: tenant && tenant !== teamId ? tenant : undefined,
    };
  } catch (err) {
    logger.warn(
      { err, organizationId: args.organizationId, connectionId },
      "Failed to resolve alternate Slack tenant for Builder admin grant",
    );
    return { teamId };
  }
}

export function buildRunJobToken(args: {
  userId: string;
  conversationId: string;
  deploymentName: string;
  channelId: string;
  teamId?: string;
  agentId: string;
  organizationId: string;
  platform: string;
  platformMetadata: Record<string, unknown>;
  runId: number;
  /**
   * Per-turn binding for token refresh: the turn-timeout marker is armed with
   * this SAME messageId, so the refresh gate requires a live marker for THIS
   * turn (deploymentName:messageId), not merely any live turn on the deployment.
   */
  messageId: string;
  /**
   * Builder admin-tool allowlist for this turn (system agent + owner/admin
   * initiator only). Carried in the encrypted token and enforced at the
   * execute gate; undefined for every normal agent/turn.
   */
  adminTools?: string[];
  /**
   * Resolved runtime provider + sandbox for this conversation (from its
   * pinned sandbox). Stamped into the token so the generic runtime route
   * picks the provider + vault credential. Undefined → local just-bash.
   */
  runtimeProviderId?: string;
  sandboxId?: string;
  /** Resolved egress allowlist for a remote runtime sandbox (signed claim). */
  allowedDomains?: string[];
  /** Resolved egress denylist for a remote runtime sandbox (signed claim). */
  deniedDomains?: string[];
  /** Resolved nix package set for a remote runtime sandbox (signed claim). */
  nixPackages?: string[];
}): string {
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

/**
 * What the recycle step did for this turn.
 *  - `recycled`  — the stale worker was torn down; the create path rebuilds it.
 *  - `unchanged` — nothing to do (healthy worker, cold start, or a failure we
 *                  deliberately swallow so a stale credential beats a lost turn).
 *  - `deferred`  — a recycle IS needed but a PREVIOUS turn is still running on
 *                  the worker. The caller must NOT dispatch onto it.
 */
type RecycleOutcome = "recycled" | "unchanged" | "deferred";

/**
 * `platformMetadata` slot counting how many times a message has been held back
 * waiting for its worker to become recyclable. Gateway-internal — stripped
 * before the payload is signed into a token or handed to a worker.
 */
const RECYCLE_DEFERRAL_KEY = "lobuRecycleDeferrals";

/**
 * Read the hold counter off a delivered payload. Anything that is not a
 * positive finite number reads as zero — the value round-trips through JSONB
 * and is the only thing bounding the hold loop, so a malformed one must fail
 * towards dispatching, never towards holding forever.
 */
function readRecycleDeferrals(
  metadata: Record<string, unknown> | undefined
): number {
  const raw = metadata?.[RECYCLE_DEFERRAL_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

export class MessageConsumer {
  /**
   * How long a held-back message waits before it is reconsidered. Long enough
   * that a short turn finishes inside one hop, short enough that the user's
   * message is not visibly stalled.
   */
  private static readonly RECYCLE_DEFER_DELAY_MS = 15_000;

  /**
   * How many times one message may be held back before the recycle is forced.
   *
   * Termination has two independent guarantees and this is the second one. The
   * first is structural: a held message arms no turn marker, so a stream of
   * arrivals cannot itself keep the deployment looking live — once the turns
   * already in flight terminalize (reply, worker crash, or the liveness
   * deadline sweep), the next arrival recycles. That covers everything except a
   * single turn that runs, and keeps heartbeating, for longer than a credential
   * has left.
   *
   * For that case the budget is the backstop: `RECYCLE_DEFER_DELAY_MS *
   * MAX_RECYCLE_DEFERRALS` ≈ 4 minutes, against the manager's 5-minute
   * lease-recycle margin. So the forced teardown lands with roughly a minute of
   * credential life left — the turn we interrupt was about to fail on an
   * expired token anyway, and the forced delete explicitly terminalizes it
   * through `failTurnsForDeployment` rather than leaving it hanging. Without
   * the budget, one runaway turn would wedge its conversation forever.
   */
  private static readonly MAX_RECYCLE_DEFERRALS = 16;

  /**
   * How many times a handler whose hold budget is already spent may wait out an
   * in-flight recycle before it goes back to holding.
   *
   * Losing the pod-local lock is the one deferral cause the budget above cannot
   * bound on its own: unlike a live turn, it is not cleared by anything the
   * message itself waits for, so a handler that keeps converting contention
   * into another hold has no terminating condition at all. Past the budget it
   * therefore stops holding and awaits the winner instead — bounded, because
   * the winner is inside `withDeploymentTurnLock`, whose `lock_timeout` caps
   * the cross-pod acquisition, and releases the local lock in a `finally` on
   * both the success and the throw path.
   *
   * Small on purpose: each wait outlives a COMPLETE teardown, and a successful
   * one removes the deployment, so the re-evaluation after the first wait
   * almost always terminates. The cap only stops a pathological hand-off
   * between handlers from spinning here.
   */
  private static readonly MAX_RECYCLE_LOCK_WAITS = 2;

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
  /**
   * The recycle currently running under `deploymentLocks`, by deployment, so a
   * handler that loses that lock can wait the winner out instead of holding its
   * message again. Pod-local by construction: it tracks a pod-local lock, and
   * the cross-pod half of the same guard is the Postgres advisory lock in
   * {@link withDeploymentTurnLock}. Entries are removed before the lock is
   * released, so a waiter never sees a promise for a lock it could have taken.
   */
  private recycleInFlight = new Map<string, Promise<void>>();
  private agentSettingsStore?: AgentSettingsStore;
  private guardrailRegistry?: GuardrailRegistry;
  private recordRunInput: typeof recordAgentRunInput;
  /** Test seam: durable "is a turn running on this deployment" probe. */
  private hasLiveTurn: typeof hasLiveTurnForDeployment;
  private runWithDeploymentTurnLock: typeof withDeploymentTurnLock;
  constructor(
    config: OrchestratorConfig,
    deploymentManager: DeploymentManager,
    // Test seams: production uses the real Postgres-backed queue and durable
    // input journal. Unit tests can capture either boundary without a database.
    queue: IMessageQueue = new RunsQueue(),
    recordRunInput: typeof recordAgentRunInput = recordAgentRunInput,
    hasLiveTurn: typeof hasLiveTurnForDeployment = hasLiveTurnForDeployment,
    runWithDeploymentTurnLock: typeof withDeploymentTurnLock = withDeploymentTurnLock
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.queue = queue;
    this.recordRunInput = recordRunInput;
    this.hasLiveTurn = hasLiveTurn;
    this.runWithDeploymentTurnLock = runWithDeploymentTurnLock;
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
      const parsedRunId = Number(jobId);
      if (!Number.isSafeInteger(parsedRunId) || parsedRunId <= 0) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "A claimed runs.id is required for message routing",
          { jobId, messageId: data.messageId },
          false
        );
      }
      data.runId = parsedRunId;

      if (!data.organizationId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "organizationId is required for message routing",
          { jobId, messageId: data.messageId },
          false
        );
      }

      if (!data.agentId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "agentId is required for message routing",
          { jobId, messageId: data.messageId },
          false
        );
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

      // How many times this message has already been held back waiting for its
      // worker to become recyclable. Read and stripped here, before anything
      // signs or forwards the payload, so the counter never reaches a token
      // claim or a worker.
      const recycleDeferrals = readRecycleDeferrals(data.platformMetadata);
      if (data.platformMetadata) {
        delete data.platformMetadata[RECYCLE_DEFERRAL_KEY];
      }

      // The message as delivered, minus the claimed row id stamped above.
      // `handleMessage` enriches `data` in place from here on (folded
      // nix/network config, a minted per-run token), and a hold re-queues THIS
      // message — which must go back unenriched. The retry assigns its own
      // `runId` and recomputes the rest.
      const asDelivered: MessagePayload = structuredClone(data);
      delete asDelivered.runId;

      // Materialize the `conversations` listing row for this turn (the single
      // sidebar source). Watcher runs stay derived from transcript snapshots
      // (one entry per watcher, not per run), so they're excluded here. Best-
      // effort: upsertConversation swallows its own errors so a listing hiccup
      // never fails a live turn.
      if (!isWatcherConversationId(effectiveConversationId)) {
        const { kind, storedPlatform } = classifyConversation(data.platform);
        // Undo the API id packing once, here at write time, and store the result —
        // readers route on the stored `thread_id`, never by re-parsing the id.
        const threadId =
          kind === "owned"
            ? threadIdFromApiConversationId({
                conversationId: effectiveConversationId,
                agentId: data.agentId,
                userId: data.userId,
                organizationId: data.organizationId,
              })
            : null;
        await upsertConversation({
          organizationId: data.organizationId,
          agentId: data.agentId,
          platform: storedPlatform,
          conversationId: effectiveConversationId,
          threadId,
          kind,
          userId: data.userId,
          title: data.messageText?.slice(0, 200) || null,
          lastActivityAt: new Date(),
        });
      }

      const canonicalConversationKey = buildCanonicalConversationKey({
        organizationId: data.organizationId,
        agentId: data.agentId,
        platform: data.platform,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
      });
      const deploymentName = generateDeploymentName({
        organizationId: data.organizationId,
        agentId: data.agentId,
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
      // A on PR #865. Every dispatch is bound to its claimed runs.id.
      // Builder admin-tool grant: only the org's system agent, only when the
      // human driving this turn is an owner/admin. Fails closed.
      //
      const { teamId: workspaceTeamId, alternateTeamId } =
        await resolveGrantTeamKeys({
          platform: data.platform,
          organizationId: data.organizationId,
          routingTeamId: data.teamId,
          platformMetadata: data.platformMetadata,
        });
      const adminTools = await resolveBuilderAdminTools({
        agentId: data.agentId,
        organizationId: data.organizationId,
        userId: data.userId,
        platform: data.platform,
        teamId: workspaceTeamId,
        alternateTeamId,
      });

      // Resolve THIS CONVERSATION's pinned runtime provider from its sandbox.
      // The pin is frozen on the first turn and read thereafter, so an agent
      // repoint never moves an existing conversation's sandbox. Undefined →
      // local just-bash.
      //
      // Best-effort at the enqueue site: resolvePinnedSelection throws on a total
      // DB failure (to fail-closed the RUNTIME realm decision), but dispatch
      // liveness must not hinge on a pin read — a blip here degrades this ONE turn
      // to unpinned rather than dropping the message. The pin self-heals on the
      // next turn (the CAS guard means an unpinned dispatch never overwrites an
      // existing pin), and the runtime route re-resolves the realm from the token.
      let runtimeSelection: Awaited<ReturnType<typeof resolvePinnedSelection>>;
      try {
        runtimeSelection = await resolvePinnedSelection({
          organizationId: data.organizationId,
          agentId: data.agentId,
          platform: data.platform,
          conversationId: effectiveConversationId,
        });
      } catch (err) {
        logger.warn(
          { traceId, agentId: data.agentId, error: getErrorMessage(err) },
          "Pin resolution failed at enqueue; dispatching this turn unpinned"
        );
        runtimeSelection = {};
      }

      // Stamp the pinned provider onto the payload body so the worker selects its
      // bash backend per-turn (a warm deployment is reused across conversations
      // pinned to different realms). The REMOTE runtime route still reads the
      // provider from the signed runJobToken below, never this body field.
      data.runtimeProviderId = runtimeSelection.runtimeProviderId;

      // Non-null once the contribution resolves; stays null when resolution
      // failed, in which case the warm path must NOT read that as a change.
      const toolingFingerprint = await this.foldConnectorTooling(data, traceId);

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
        sandboxId: runtimeSelection.sandboxId,
        // Egress allow/deny lists as signed claims (kept in lockstep with the
        // deployment-token mint) — the runtime route reads them, never the body.
        allowedDomains: data.networkConfig?.allowedDomains,
        deniedDomains: data.networkConfig?.deniedDomains,
        // Same rule for the package set: signed, so the remote runtime never
        // takes a package list off the wire from the worker.
        nixPackages: data.nixConfig?.packages,
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
            data.agentId,
            { organizationId: data.organizationId }
          );
          const resolved = resolveAgentGuardrails(
            settings ?? { guardrails: [] },
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
              void recordGuardrailTrip({
                organizationId: data.organizationId,
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

      // Recycle a stale worker BEFORE the turn becomes deliverable. Doing this
      // after enqueue cannot be made safe by an idleness check: the worker can
      // claim the newly-queued turn between the check and the SIGTERM, so a
      // reply would be lost. Nothing below this point is reachable by the
      // worker yet, so a teardown here can only interrupt a PREVIOUS turn —
      // and `hasExpiringLease`/`hasToolingChanged` are only consulted for a
      // deployment that has already gone quiet enough to be reusable.
      const recycleOutcome = await this.recycleStaleDeployment(
        deploymentName,
        toolingFingerprint,
        traceId,
        // Budget exhausted: stop deferring and tear the worker down even though
        // a turn is in flight. See MAX_RECYCLE_DEFERRALS for why that is the
        // right end state rather than serving another turn on a dead credential.
        recycleDeferrals >= MessageConsumer.MAX_RECYCLE_DEFERRALS
      );

      // A recycle that could not run means this worker is unfit to serve
      // another turn: its credential is expiring, or the connection behind its
      // tooling was repointed or revoked. Dispatching anyway is what made the
      // deferral self-perpetuating — the new turn arms its own liveness marker,
      // that marker keeps the deployment looking busy, and under a steady
      // arrival rate the recycle never gets its quiet moment while every turn
      // runs on the stale credential. So hold the message instead: nothing is
      // armed, nothing is enqueued, and the deployment goes quiet on schedule.
      if (recycleOutcome === "deferred") {
        await this.holdMessageForRecycle(
          asDelivered,
          deploymentName,
          recycleDeferrals,
          traceId
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

      // EXACT-MODEL GATE (enqueue chokepoint — covers cold AND warm/resumed):
      // BOTH the cold and warm paths funnel through here before
      // `sendToWorkerQueue` serializes `data.agentOptions.model` into the queue
      // job that the worker reads verbatim. Deployment-time enforcement is too
      // late — warm workers never re-run createWorkerDeployment. So enforce the
      // agent's exact allow-list on the payload model NOW, before it's persisted.
      await this.enforceModelPolicyAtEnqueue(data);

      // Persist before queue delivery so a worker reconnect cannot lose the input.
      await this.recordRunInput(data, deploymentName);

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
  /**
   * Enforce the agent's exact-model allow-list on the OUTBOUND payload model,
   * at enqueue time. This is the authoritative gate: every dispatch lane
   * (direct API, Listen bridge, chat-instance, watcher HTTP, scheduled-job
   * direct enqueue) — cold, warm, or resumed — funnels through `handleMessage`
   * → here → `sendToWorkerQueue`, which serializes `data.agentOptions.model`
   * into the queue job the worker reads verbatim. Mutating the model here
   * guarantees a disallowed/stale/sentinel model can never reach the worker,
   * regardless of whether a deployment is (re)created.
   *
   * Uses the SHARED `resolveDispatchModel` resolver (same one session-context
   * uses) so both layers agree on the effective model — a disallowed/sentinel
   * request is replaced with the first listed ref that is non-sentinel AND
   * routable, not merely non-sentinel.
   *
   * FAILS CLOSED on a policy-lookup error: a DB/catalog blip must NEVER let a
   * disallowed or sentinel model reach the worker. Since the warm path never
   * re-runs createWorkerDeployment, we cannot rely on the deployment-time gate
   * as a fallback — so when the lookup throws AND a model was requested, we DROP
   * the model (worker resolves the agent/org default or surfaces
   * NO_MODEL_CONFIGURED), never leaving the unvalidated requested model in place.
   */
  private async enforceModelPolicyAtEnqueue(
    data: MessagePayload
  ): Promise<void> {
    const requested = data.agentOptions?.model;
    if (!requested) return;
    // FAIL CLOSED when we cannot scope/run a policy check for a REQUESTED model:
    //  - no agentId → can't identify the agent's policy;
    //  - no catalog → the ProviderCatalogService isn't wired yet (startup, or a
    //    persisted job drained before wiring). The warm worker would otherwise
    //    read the unvalidated model verbatim.
    // In every such case we DROP the model rather than silently pass it.
    if (!data.agentId) {
      logger.warn(
        { requestedModel: requested },
        "Enqueue-time model gate: missing agentId — dropping the requested model (fail-closed)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
      return;
    }
    const catalog = this.deploymentManager.getProviderCatalogService?.();
    if (!catalog) {
      logger.warn(
        { agentId: data.agentId, requestedModel: requested },
        "Enqueue-time model gate: ProviderCatalogService not wired — dropping the requested model (fail-closed)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
      return;
    }
    // CROSS-TENANT GUARD: a policy-enforcement read MUST be org-scoped. A
    // declared agent id (e.g. `lobu-builder`) exists in EVERY org, so an
    // id-only lookup could enforce another tenant's models list. If the org is
    // somehow missing here, fail closed (drop the model) rather than risk
    // gating against the wrong org's policy.
    if (!data.organizationId) {
      logger.warn(
        { agentId: data.agentId, requestedModel: requested },
        "Enqueue-time model gate: missing organizationId — dropping the requested model (fail-closed, cross-tenant guard)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
      return;
    }
    try {
      const resolved = await catalog.resolveDispatchModel(
        data.agentId,
        data.organizationId,
        requested,
        data.userId
      );
      if (!resolved.replaced) return;
      logger.warn(
        {
          agentId: data.agentId,
          organizationId: data.organizationId,
          requestedModel: requested,
          allowedRefs: resolved.allowedRefs,
          effectiveModel: resolved.model ?? null,
        },
        "Enqueue-time model gate: requested model is not routable under the agent's allowed models list — enforcing (fail-closed)"
      );
      if (data.agentOptions) {
        if (resolved.model) data.agentOptions.model = resolved.model;
        else delete data.agentOptions.model;
      }
    } catch (err) {
      // FAIL CLOSED: never leave an unvalidated requested model on the payload.
      // The warm path won't re-gate at deployment time, so a lookup failure must
      // drop the model rather than let a possibly-disallowed/sentinel model run.
      logger.warn(
        { agentId: data.agentId, err: getErrorMessage(err) },
        "Enqueue-time model gate: policy lookup FAILED — dropping the requested model (fail-closed)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
    }
  }

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
   * Fold the org's connector-contributed packages and domains into the queue
   * payload, in place.
   *
   * MUST run before the per-run worker token is minted: a remote runtime trusts
   * only the signed claim, never the payload body. Packages are folded as well
   * as domains because `syncNetworkConfigGrants` reconciles this payload against
   * the grant store on the warm path and derives the nix binary-cache hosts from
   * `nixConfig.packages` — folding domains alone lets that reconcile revoke the
   * substituter hosts the contributed packages depend on.
   *
   * Never throws: a resolution failure leaves the payload untouched and the
   * sandbox runs without the contribution, rather than failing the turn.
   *
   * Returns the contribution's tooling fingerprint, or null when resolution
   * failed. The warm path compares it against what the deployment was built
   * with, so null must read as "no evidence of change" — a transient DB error
   * keeps a healthy worker instead of recycling it every turn.
   */
  protected async foldConnectorTooling(
    data: MessagePayload,
    traceId: string
  ): Promise<string | null> {
    try {
      const contribution = await resolveAgentToolingDeclaration({
        organizationId: data.organizationId,
      });
      if (contribution.domains.length > 0) {
        data.networkConfig = {
          ...data.networkConfig,
          allowedDomains: [
            ...new Set([
              ...(data.networkConfig?.allowedDomains ?? []),
              ...contribution.domains,
            ]),
          ],
        };
      }
      if (contribution.packages.length > 0) {
        data.nixConfig = {
          ...data.nixConfig,
          packages: [
            ...new Set([
              ...(data.nixConfig?.packages ?? []),
              ...contribution.packages,
            ]),
          ],
        };
      }
      return contribution.fingerprint;
    } catch (error) {
      logger.warn(
        { traceId, agentId: data.agentId, error: getErrorMessage(error) },
        "Failed to resolve connector tooling contribution; continuing without it"
      );
      return null;
    }
  }

  /**
   * Tear down a warm deployment whose connector credential is expiring or whose
   * tooling no longer matches the org's connections, so the create path rebuilds
   * it with a fresh lease. A worker reads its env once at process start, so
   * recycling is the only way to change what a sandbox holds.
   *
   * Two separate protections, because they cover different turns:
   * - MUST be called before the turn is enqueued. After enqueue the worker can
   *   claim it at any moment, and no idleness check closes that window — the
   *   worker can start between the check and the SIGTERM, losing the reply.
   * - A PREVIOUS turn may still be running, which ordering alone cannot rule
   *   out, so the durable turn marker is consulted before any teardown.
   *
   * Returns `deferred` when a recycle is needed but could not be performed —
   * either a previous turn is still live, or another handler in this process is
   * already tearing this exact worker down. Both mean the same thing to the
   * caller: this worker must not serve the turn, so hold the message rather
   * than dispatch it — see {@link holdMessageForRecycle}.
   *
   * `force` waives both deferrals: it skips the liveness check, and past the
   * budget it waits an in-flight recycle out rather than holding again. Only
   * the caller's deferral budget sets it, so neither a long-running turn nor a
   * slow teardown can wedge the conversation forever.
   *
   * Never throws: a stale credential beats a failed turn, and the idle reaper
   * clears the deployment eventually either way.
   */
  private async recycleStaleDeployment(
    deploymentName: string,
    toolingFingerprint: string | null,
    traceId: string,
    force: boolean
  ): Promise<RecycleOutcome> {
    try {
      for (let waits = 0; ; waits += 1) {
        // Establish there IS a warm deployment before reading any lease state.
        // On a cold start nothing has been minted yet, so those reads are
        // guaranteed-unused work — and a DeploymentManager that implements only
        // the cold path (as the owned-elsewhere suite's fake deliberately does)
        // would throw on them.
        const deployments = await this.deploymentManager.listDeployments();
        if (!deployments.some((d) => d.deploymentName === deploymentName)) {
          return "unchanged";
        }

        // Read staleness BEFORE contending for the per-deployment lock. Both
        // reads are pod-local and cheap, and the answer decides what losing the
        // lock MEANS: for a healthy worker it means nothing, but for a stale one
        // it means a teardown is already under way and this turn must not be
        // dispatched onto the worker that is about to disappear.
        if (!this.isRecycleNeeded(deploymentName, toolingFingerprint)) {
          return "unchanged";
        }

        // The same per-deployment lock the create path uses, so teardown and
        // create are mutually exclusive. Without it two handlers can both pass
        // the liveness check, both tear down, and the SECOND delete lands on
        // the REPLACEMENT worker — killing a turn that was already enqueued to
        // it.
        if (this.acquireDeploymentLock(deploymentName)) {
          const running = this.recycleUnderTurnLock(
            deploymentName,
            toolingFingerprint,
            traceId,
            force
          );
          // Published for the losers to wait on, already-handled: their `await`
          // must not turn this handler's failure into an unhandled rejection,
          // and they re-read state afterwards rather than trusting an outcome.
          this.recycleInFlight.set(
            deploymentName,
            running.then(
              () => undefined,
              () => undefined
            )
          );
          try {
            return await running;
          } finally {
            this.recycleInFlight.delete(deploymentName);
            this.releaseDeploymentLock(deploymentName);
          }
        }

        // Losing the lock means another handler in this process is already
        // recycling this deployment. Reporting that as `unchanged` is the same
        // defect the liveness deferral has: the loser would arm its marker and
        // enqueue onto the expiring or revoked worker the winner is mid-way
        // through replacing.
        //
        // So hold — but holding is only bounded while the hold counter is
        // climbing towards the budget. Once that is spent, wait the winner out
        // and re-evaluate instead, or contention becomes an unbounded second
        // deferral axis that the budget never reaches. Nothing to wait on means
        // the create path holds the lock, not a recycle; that resolves on its
        // own and a hold is the safe answer.
        const inFlight = this.recycleInFlight.get(deploymentName);
        if (
          force &&
          inFlight &&
          waits < MessageConsumer.MAX_RECYCLE_LOCK_WAITS
        ) {
          logger.info(
            { traceId, deploymentName },
            "Hold budget spent — waiting out the in-flight recycle instead of holding again"
          );
          await inFlight;
          continue;
        }
        logger.info(
          { traceId, deploymentName },
          "Holding this turn: another handler is already recycling this deployment"
        );
        return "deferred";
      }
    } catch (error) {
      logger.warn(
        { traceId, deploymentName, error: getErrorMessage(error) },
        "Failed to recycle a stale deployment; continuing with the existing worker"
      );
      return "unchanged";
    }
  }

  /**
   * Is this deployment's connector state stale enough to need a rebuild?
   *
   * `toolingFingerprint === null` means resolution failed this turn, which is
   * absence of evidence, not evidence of change — treating it as a change would
   * recycle every warm worker on a transient DB blip.
   */
  private isRecycleNeeded(
    deploymentName: string,
    toolingFingerprint: string | null
  ): boolean {
    const toolingChanged =
      toolingFingerprint != null &&
      this.deploymentManager.hasToolingChanged(
        deploymentName,
        toolingFingerprint
      );
    return (
      toolingChanged || this.deploymentManager.hasExpiringLease(deploymentName)
    );
  }

  /** The teardown itself, serialized cross-pod. Callers hold the pod-local lock. */
  private async recycleUnderTurnLock(
    deploymentName: string,
    toolingFingerprint: string | null,
    traceId: string,
    force: boolean
  ): Promise<RecycleOutcome> {
    return await this.runWithDeploymentTurnLock(
      deploymentName,
      async (): Promise<RecycleOutcome> => {
        // Re-check after taking the cross-pod lock: another owner may have
        // removed the worker while this caller waited.
        const current = await this.deploymentManager.listDeployments();
        if (!current.some((d) => d.deploymentName === deploymentName)) {
          return "unchanged";
        }

        const toolingChanged =
          toolingFingerprint != null &&
          this.deploymentManager.hasToolingChanged(
            deploymentName,
            toolingFingerprint
          );
        const leaseExpiring =
          this.deploymentManager.hasExpiringLease(deploymentName);
        if (!toolingChanged && !leaseExpiring) return "unchanged";

        // Pre-enqueue ordering protects THIS turn, but a PREVIOUS one may
        // still be running on the worker: message 1 starts a long turn,
        // message 2 arrives and would SIGTERM it before enqueueing, costing
        // the user message 1's reply. The durable turn marker is the
        // authority here — Postgres-backed, so it sees a turn started by
        // another replica too. The same advisory lock is taken by the
        // transaction that arms a turn marker, so a concurrent turn either
        // lands first and is seen here, or waits until teardown has completed
        // before it can enqueue.
        if (!force && (await this.hasLiveTurn(deploymentName))) {
          // Interrupting a live turn loses a reply outright, so the previous
          // turn is allowed to finish. What the CALLER must not do is take
          // that as permission to run this turn on the worker anyway — see
          // the `deferred` branch in handleMessage.
          logger.info(
            { traceId, deploymentName, tooling_changed: toolingChanged },
            "Deferring deployment recycle: a turn is still in flight"
          );
          return "deferred";
        }

        logger.info(
          { traceId, deploymentName, tooling_changed: toolingChanged },
          toolingChanged
            ? "Connector tooling changed — recycling deployment to pick it up"
            : "Connector lease expiring — recycling deployment to re-mint"
        );
        // deleteWorkerDeployment, not the low-level deleteDeployment: it also
        // clears the secret placeholder mappings and the backing
        // `deployments/{name}/` secret entries. A recycle can fire once per
        // credential lifetime per conversation, so leaking those would
        // accumulate (and AWS Secrets Manager entries would leak permanently).
        await this.deploymentManager.deleteWorkerDeployment(deploymentName, {
          failInFlightTurns: force,
        });
        return "recycled";
      }
    );
  }

  /**
   * Hold a message back because its worker must be recycled before it can serve
   * another turn, and a previous turn is still running on it.
   *
   * Re-queues the message rather than failing the run: the turn is owed a reply
   * and nothing has gone wrong — the worker is simply not fit to take it yet.
   * Nothing was armed and nothing was enqueued, so this deployment gains no new
   * liveness from the hold. That is what makes the wait terminate: however fast
   * messages arrive, the turns already in flight are the only ones keeping the
   * worker busy, and each of them terminalizes (reply, crash, or the liveness
   * deadline sweep).
   */
  private async holdMessageForRecycle(
    asDelivered: MessagePayload,
    deploymentName: string,
    deferrals: number,
    traceId: string
  ): Promise<void> {
    const attempt = deferrals + 1;
    await this.queue.send(
      "messages",
      {
        ...asDelivered,
        platformMetadata: {
          ...asDelivered.platformMetadata,
          [RECYCLE_DEFERRAL_KEY]: attempt,
        },
      },
      {
        delayMs: MessageConsumer.RECYCLE_DEFER_DELAY_MS,
        retryLimit: this.config.queues.retryLimit,
        retryDelay: this.config.queues.retryDelay,
        expireInSeconds: this.config.queues.expireInSeconds,
        // A key per hold, NOT the producer's original: that one belongs to the
        // run being completed right now, so reusing it would ON CONFLICT into a
        // no-op and drop the user's message outright. Including the attempt
        // number also makes concurrent holds of the same message at the same
        // count collapse to one row instead of fanning out. Colons are stripped
        // for the same reason the producer strips them — platform ids embed
        // them and the key must stay a single opaque segment.
        singletonKey:
          `recycle-hold-${attempt}-${deploymentName}-${asDelivered.messageId}`.replace(
            /:/g,
            "-"
          ),
      }
    );
    logger.warn(
      {
        traceId,
        deploymentName,
        messageId: asDelivered.messageId,
        attempt,
        maxAttempts: MessageConsumer.MAX_RECYCLE_DEFERRALS,
      },
      "Held a message back: its worker holds a stale connector credential and a previous turn is still running"
    );
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

      // Emit the startup-failure notice through the first-writer-wins election
      // (atomic delete-marker + enqueue-error in one tx). This is gated on the
      // marker still being pending: if a still-attached worker raced a real
      // terminal reply (which discharged the marker), this no-ops instead of
      // double-signalling the client. Carries a code so it renders end-to-end
      // through the AGENT_ERRORS catalog (SSE + CLI + platforms) with one
      // source of prose. If the marker was never armed it also no-ops.
      await failTurnIfPending(
        deploymentName,
        data.messageId,
        AgentErrorCode.WORKER_STARTUP_FAILED
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
        error: getErrorMessage(error),
      };
    }
  }
}
