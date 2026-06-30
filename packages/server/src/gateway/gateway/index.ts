#!/usr/bin/env bun

import type {
  ConfigProviderMeta,
  InstructionContext,
  WorkerTokenData,
} from "@lobu/core";
import {
	createLogger,
	generateWorkerToken,
	encrypt,
	verifyWorkerToken,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { bindRequestAbortToStream } from "../../events/sse-abort-bridge.js";
import type { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { getRevokedTokenStore } from "../auth/revoked-token-store.js";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { McpProxy } from "../auth/mcp/proxy.js";
import type { McpTool } from "../auth/mcp/tool-cache.js";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";
import { resolveEffectiveModelRef } from "../auth/settings/model-selection.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import {
  commitTerminalReply,
  extendTurnDeadlines,
  hasLiveTurnForMessage,
} from "../orchestration/turn-liveness.js";
import type { InstructionService } from "../services/instruction-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  type SSEWriter,
  WorkerConnectionManager,
} from "./connection-manager.js";
import { WorkerJobRouter } from "./job-router.js";
import { createTranscriptRoutes } from "./transcript-routes.js";

const logger = createLogger("worker-gateway");

/**
 * Minimal seam onto the deployment manager's idle clock. Any worker-driven
 * signal (HTTP response / ACK) must refresh the deployment's `lastActivity` so
 * the idle reaper doesn't scale a long-running-but-active worker to 0 mid-turn.
 * Narrow on purpose: the gateway only needs to touch the idle clock, not the
 * full deployment lifecycle.
 */
export interface DeploymentActivityTracker {
  updateDeploymentActivity(deploymentName: string): Promise<void>;
}

/**
 * Worker Gateway - SSE and HTTP endpoints for worker communication
 * Workers connect via SSE to receive jobs, send responses via HTTP POST
 * Uses encrypted tokens for authentication and routing
 */
export class WorkerGateway {
  private app: Hono;
  private connectionManager: WorkerConnectionManager;
  private jobRouter: WorkerJobRouter;
  private queue: IMessageQueue;
  private mcpConfigService: McpConfigService;
  private instructionService: InstructionService;
  private publicGatewayUrl: string;
  private mcpProxy?: McpProxy;
  private providerCatalogService?: ProviderCatalogService;
  private agentSettingsStore?: AgentSettingsStore;
  private deploymentActivityTracker?: DeploymentActivityTracker;

  constructor(
    queue: IMessageQueue,
    publicGatewayUrl: string,
    mcpConfigService: McpConfigService,
    instructionService: InstructionService,
    mcpProxy?: McpProxy,
    providerCatalogService?: ProviderCatalogService,
    agentSettingsStore?: AgentSettingsStore
  ) {
    this.queue = queue;
    this.publicGatewayUrl = publicGatewayUrl;
    this.connectionManager = new WorkerConnectionManager();
    this.jobRouter = new WorkerJobRouter(queue, this.connectionManager);
    this.mcpConfigService = mcpConfigService;
    this.instructionService = instructionService;
    this.mcpProxy = mcpProxy;
    this.providerCatalogService = providerCatalogService;
    this.agentSettingsStore = agentSettingsStore;

    // Setup Hono app
    this.app = new Hono();
    this.setupRoutes();
  }

  /**
   * Get the Hono app
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Get the connection manager (for sending SSE notifications from external routes)
   */
  getConnectionManager(): WorkerConnectionManager {
    return this.connectionManager;
  }

  /**
   * Wire the deployment manager's idle clock so worker responses keep a
   * long-running worker alive in the idle reaper. Injected after construction
   * because the gateway and the orchestrator (which owns the deployment
   * manager) are built separately; the gateway runs without it (the tracker is
   * optional) but then a worker active past WORKER_IDLE_CLEANUP_MINUTES with no
   * new inbound message can be reaped mid-turn.
   */
  setDeploymentActivityTracker(tracker: DeploymentActivityTracker): void {
    this.deploymentActivityTracker = tracker;
  }

  /**
   * Setup routes on Hono app
   */
  private setupRoutes() {
    // SSE endpoint for workers to receive jobs
    // Routes are mounted at /worker, so paths here should be relative
    this.app.get("/stream", (c) => this.handleStreamConnection(c));

    // HTTP POST endpoint for workers to send responses
    this.app.post("/response", (c) => this.handleWorkerResponse(c));

    // Unified session context endpoint (includes MCP + instructions)
    this.app.get("/session-context", (c) =>
      this.handleSessionContextRequest(c)
    );

    // Mint a fresh worker token while the deployment still has live work.
    // Lets a warm worker (or a single turn running past the 2h TTL) keep a
    // non-expired token without lengthening the TTL — see handler.
    this.app.post("/token/refresh", (c) => this.handleTokenRefresh(c));

    // Per-run transcript snapshots — backs the multi-replica unblock.
    // Workers hydrate from the latest completed snapshot on boot and POST
    // a new snapshot on every terminal state. The routes themselves are
    // always mounted (gated by the JWT scope check inside).
    this.app.route("/transcript", createTranscriptRoutes());

    logger.debug("Worker gateway routes registered");
  }

  private enrichMcpStatus(
    mcpStatus: Array<{
      id: string;
      name: string;
      requiresAuth: boolean;
      requiresInput: boolean;
    }>
  ): Array<{
    id: string;
    name: string;
    requiresAuth: boolean;
    requiresInput: boolean;
    authenticated: boolean;
    configured: boolean;
  }> {
    return mcpStatus.map((mcp) => ({
      ...mcp,
      authenticated: false,
      configured: !mcp.requiresInput,
    }));
  }

  /**
   * Handle SSE connection from worker
   */
  private async handleStreamConnection(c: Context): Promise<Response> {
    const auth = await this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { deploymentName, userId, conversationId, agentId } =
      auth.tokenData as any;
    if (!conversationId) {
      return c.json({ error: "Invalid token (missing conversationId)" }, 401);
    }

    // Extract httpPort from query params (worker HTTP server registration)
    const httpPortParam = c.req.query("httpPort");
    const httpPort = httpPortParam ? parseInt(httpPortParam, 10) : undefined;

    // Create an SSE stream.
    //
    // Hono's `stream()` only fires `streamWriter.onAbort()` from
    // `ReadableStream.cancel()` — which doesn't run on abnormal disconnects
    // (LB idle timeout, intermediate proxy kill, worker pod hard exit). On
    // Node + current Bun the per-request `AbortSignal` is the only reliable
    // trigger. Without bridging it, a stale worker SSE leaks the writer
    // closure + `while !isClosed` loop until the 10-minute stale-cleanup
    // sweep catches up. Same retain pattern fixed for the invalidation
    // streams in #833. Refs #782.
    const requestSignal = c.req.raw.signal;

    return stream(c, async (streamWriter) => {
      let isClosed = false;

      // If the client already aborted between handler invocation and stream
      // body execution, bail out before registering anything.
      if (requestSignal?.aborted) {
        return;
      }

      // Create an SSE writer adapter
      const sseWriter: SSEWriter = {
        write: (data: string): boolean => {
          try {
            void streamWriter.write(data);
            return true;
          } catch {
            return false;
          }
        },
        end: () => {
          try {
            streamWriter.close();
          } catch {
            // Already closed
          }
        },
        onClose: (callback: () => void) => {
          streamWriter.onAbort(() => {
            isClosed = true;
            callback();
          });
        },
      };

      // Idempotent cleanup latch. The `onClose` subscriber must be registered
      // BEFORE the async pauseWorker/addConnection/registerWorker block so an
      // abort fired during that window can't leave a dead writer registered
      // in the connection manager. `connectionAdded` flips true the instant
      // we hand the writer to `addConnection`; the cleanup latch reads it and
      // either removes the registration (post-add) or no-ops (pre-add). The
      // `aborted` flag short-circuits the async setup so we don't even add a
      // dead writer.
      let connectionAdded = false;
      let cleanupRan = false;
      let aborted = false;
      const runCleanup = () => {
        if (cleanupRan) return;
        cleanupRan = true;
        aborted = true;
        if (!connectionAdded) {
          // Aborted before we registered; nothing to remove.
          return;
        }
        const current = this.connectionManager.getConnection(deploymentName);
        if (current && current.writer !== sseWriter) {
          logger.debug(
            `Ignoring stale disconnect for ${deploymentName} (replaced by newer SSE)`
          );
          return;
        }
        this.jobRouter.pauseWorker(deploymentName).catch((err) => {
          logger.error(`Failed to pause worker ${deploymentName}:`, err);
        });
        this.connectionManager.removeConnection(deploymentName);
      };

      // Register the disconnect subscriber FIRST so an abort during the
      // async setup block below routes through the same idempotent latch.
      sseWriter.onClose(runCleanup);

      // Bridge per-request AbortSignal to the stream so abnormal disconnects
      // tear the writer down (Hono's onAbort alone doesn't fire on those).
      const detachAbortBridge = bindRequestAbortToStream(
        requestSignal,
        streamWriter
      );

      // Set SSE headers
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");

      // Clean up stale state before registering new connection.
      // When a container dies without cleanly closing its TCP socket,
      // the old SSE connection may still appear valid. Pause the BullMQ
      // worker first to prevent it from sending jobs to the dead connection,
      // then remove the stale connection so any in-flight handleJob will
      // fail and trigger a retry against the new connection.
      await this.jobRouter.pauseWorker(deploymentName);

      // If the request aborted during the await above, bail before touching
      // the connection manager. The cleanup latch already fired via the
      // abort bridge → onAbort → onClose path.
      if (aborted || requestSignal?.aborted) {
        detachAbortBridge();
        runCleanup();
        return;
      }

      if (this.connectionManager.isConnected(deploymentName)) {
        logger.info(
          `Cleaning up stale connection for ${deploymentName} before new SSE`
        );
        // Intentionally no expectedWriter — always evict the old connection
        this.connectionManager.removeConnection(deploymentName);
      }

      // Register new (live) connection
      this.connectionManager.addConnection(
        deploymentName,
        userId,
        conversationId,
        agentId || "",
        sseWriter,
        httpPort
      );
      connectionAdded = true;

      // If we lost the race — abort fired between the pre-check above and
      // here — drop the writer we just registered.
      if (aborted || requestSignal?.aborted) {
        detachAbortBridge();
        runCleanup();
        return;
      }

      // Register BullMQ worker (idempotent) and resume job processing
      await this.jobRouter.registerWorker(deploymentName);
      await this.jobRouter.resumeWorker(deploymentName);

      // Keep the connection open until the stream is actually aborted.
      try {
        while (!isClosed) {
          await streamWriter.sleep(1000);
        }
      } finally {
        detachAbortBridge();
      }
    });
  }

  /**
   * Handle HTTP response from worker
   */
  private async handleWorkerResponse(c: Context): Promise<Response> {
    const auth = await this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { deploymentName } = auth.tokenData;

    // Update connection activity (SSE stale-cleanup clock).
    this.connectionManager.touchConnection(deploymentName);
    // Also refresh the DEPLOYMENT manager's idle clock. `touchConnection` above
    // only feeds the connection manager's stale-SSE sweep — it does NOT touch
    // `EmbeddedWorkerEntry.lastActivity`, which the idle reaper
    // (reconcileDeployments → buildDeploymentInfoSummary.isIdle) reads. Without
    // this, that timestamp stays frozen at the last dispatch, so a worker
    // running a single long turn (no new inbound message) past
    // WORKER_IDLE_CLEANUP_MINUTES is scaled to 0 and killed mid-turn. Every
    // worker-driven HTTP response (delta, status_update, ACK, terminal reply)
    // hits this path, so any liveness signal keeps the idle clock fresh; a
    // truly silent worker still stops POSTing and ages out as intended.
    void this.deploymentActivityTracker
      ?.updateDeploymentActivity(deploymentName)
      .catch((err) => {
        logger.warn(
          `[WORKER-GATEWAY] Failed to refresh deployment activity for ${deploymentName}: ${err}`
        );
      });

    try {
      const body = await c.req.json();
      const { jobId, ...responseData } = body;
      // Stamp the worker token's owning org onto the response so the row
      // landed in `thread_response` carries organization_id — the snapshot
      // ownership verifier in transcript-routes.ts denies POSTs to NULL-org
      // rows. The worker doesn't know its org (token-scoped, not payload-
      // scoped) so it relies on the gateway to inject it from the auth.
      const orgEnriched =
        auth.tokenData.organizationId && !responseData.organizationId
          ? { ...responseData, organizationId: auth.tokenData.organizationId }
          : responseData;
      const enrichedResponse =
        auth.tokenData.connectionId &&
        (!orgEnriched.platformMetadata ||
          typeof orgEnriched.platformMetadata === "object")
          ? {
              ...orgEnriched,
              platformMetadata: {
                ...(orgEnriched.platformMetadata || {}),
                connectionId: auth.tokenData.connectionId,
              },
            }
          : orgEnriched;

      // Acknowledge job completion if jobId provided
      if (jobId) {
        this.jobRouter.acknowledgeJob(jobId);
      }

      // Delivery receipts (worker ACKs) have no message payload — just acknowledge and return
      if (enrichedResponse.received) {
        if (enrichedResponse.heartbeat) {
          // touchConnection already ran above for all /worker/response calls,
          // keeping this worker alive in stale-cleanup.
          logger.debug(
            `[WORKER-GATEWAY] Received heartbeat ACK from ${deploymentName}`
          );
        }
        // A worker ACK (delivery receipt or heartbeat) is a worker-driven
        // liveness signal — push the turn-liveness deadline forward so a live
        // but slow worker is never falsely failed by the sweep. Best-effort.
        void extendTurnDeadlines(deploymentName);
        return c.json({ success: true });
      }

      // The worker's 20s status_update (HEARTBEAT_INTERVAL_MS in
      // session-runner.ts) carries `statusUpdate` and NO `received` flag, so it
      // falls through the ACK block above. It is the most frequent worker-driven
      // liveness signal — far more frequent than the 30s SSE-ping ACK — so it
      // must refresh the turn-liveness deadline too, otherwise a live worker
      // emitting status updates every 20s could still lapse the 60s deadline on
      // ~2 consecutive missed ping ACKs and be falsely failed by the sweep.
      // Best-effort, same as the ACK path.
      if (enrichedResponse.statusUpdate) {
        void extendTurnDeadlines(deploymentName);
      }

      // Log for debugging
      logger.info(
        `[WORKER-GATEWAY] Received response with fields: ${Object.keys(enrichedResponse).join(", ")}`
      );
      if (enrichedResponse.delta) {
        logger.info(
          `[WORKER-GATEWAY] Stream delta: deltaLength=${enrichedResponse.delta.length}`
        );
      }

      // Send response to thread_response queue. TERMINAL rows (success
      // completion via processedMessageIds, or error) are subject to the API
      // owner-gate in routeToRenderer — a non-owning replica re-queues them —
      // so they need the elevated retry budget to survive cross-pod hand-off.
      // Non-terminal deltas/status keep default options (not owner-gated).
      const isTerminalResponse = !!(
        enrichedResponse.error ||
        (Array.isArray(enrichedResponse.processedMessageIds) &&
          enrichedResponse.processedMessageIds.length > 0)
      );

      if (isTerminalResponse) {
        // The worker produced a real terminal reply (success or explicit
        // error). Persist the reply AND discharge the turn-liveness marker(s)
        // for the message(s) it processed in ONE transaction — so a pod crash
        // can't leave a surviving marker that the sweep would later turn into a
        // duplicate "worker stopped" error. The terminal row carries the
        // elevated retry budget (applied inside commitTerminalReply) so it
        // survives the owner-gate re-queue to the SSE-holding pod.
        const dischargeIds = new Set<string>();
        if (typeof enrichedResponse.messageId === "string") {
          dischargeIds.add(enrichedResponse.messageId);
        }
        for (const id of enrichedResponse.processedMessageIds ?? []) {
          if (typeof id === "string") dischargeIds.add(id);
        }
        await commitTerminalReply(
          deploymentName,
          [...dischargeIds],
          enrichedResponse,
          (enrichedResponse.organizationId as string | undefined) ?? null
        );
      } else {
        // Non-terminal (delta / status): best-effort, not owner-gated.
        await this.queue.send("thread_response", enrichedResponse);
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error(`Error handling worker response: ${error}`);
      return c.json({ error: "Failed to process response" }, 500);
    }
  }

  /**
   * Unified session context endpoint
   */
  private async handleSessionContextRequest(c: Context): Promise<Response> {
    if (!this.mcpConfigService || !this.instructionService) {
      return c.json({ error: "session_context_unavailable" }, 503);
    }

    const auth = await this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    try {
      const {
        userId,
        platform,
        sessionKey,
        conversationId,
        agentId,
        deploymentName,
      } = auth.tokenData;
      const baseUrl = this.getRequestBaseUrl(c);
      if (!conversationId) {
        return c.json({ error: "Invalid token (missing conversationId)" }, 401);
      }

      // Build instruction context
      const instructionContext: InstructionContext = {
        userId,
        agentId: agentId || "",
        sessionKey: sessionKey || "",
        workingDirectory: "/workspace",
        availableProjects: [],
      };

      // Build settings URL as a short-lived claim link so platform users
      // can open it without a pre-existing browser session.
      const CLAIM_TTL_MS = 10 * 60 * 1000; // 10 minutes
      const claimToken = encrypt(
        JSON.stringify({
          userId,
          platform: platform || "unknown",
          agentId: agentId || undefined,
          exp: Date.now() + CLAIM_TTL_MS,
        })
      );
      const settingsUrl = new URL("/connect/claim", baseUrl);
      settingsUrl.searchParams.set("claim", claimToken);
      if (agentId) {
        settingsUrl.searchParams.set("agent", agentId);
      }

      // Fetch MCP config and session context in parallel
      const [mcpConfig, contextData] = await Promise.all([
        this.mcpConfigService.getWorkerConfig({
          baseUrl,
          workerToken: auth.token,
          deploymentName,
        }),
        this.instructionService.getSessionContext(
          platform || "unknown",
          instructionContext,
          { settingsUrl: settingsUrl.toString() }
        ),
      ]);

      const enrichedMcpStatus = this.enrichMcpStatus(contextData.mcpStatus);

      // Fetch tool lists and instructions for ALL MCPs (unauthenticated ones
      // will attempt discovery without credentials)
      const mcpTools: Record<string, McpTool[]> = {};
      const mcpInstructions: Record<string, string> = {};
      if (this.mcpProxy && enrichedMcpStatus.length > 0) {
        const toolResults = await Promise.allSettled(
          enrichedMcpStatus.map(async (mcp) => {
            const result = await this.mcpProxy?.fetchToolsForMcp(
              mcp.id,
              agentId || userId,
              auth.tokenData,
              auth.token
            );
            return { mcpId: mcp.id, ...(result || { tools: [] }) };
          })
        );

        for (const result of toolResults) {
          if (result.status === "fulfilled") {
            if (result.value.tools && result.value.tools.length > 0) {
              mcpTools[result.value.mcpId] = result.value.tools;
            }
            if (result.value.instructions) {
              mcpInstructions[result.value.mcpId] = result.value.instructions;
            }
          } else {
            logger.error("MCP tool fetch rejected", {
              reason:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
          }
        }
      }

      // Resolve dynamic provider configuration
      const agentSettings =
        this.agentSettingsStore && agentId
          ? await this.agentSettingsStore.getSettings(agentId)
          : null;
      const providerConfig = await this.resolveProviderConfig(
        agentId || "",
        resolveEffectiveModelRef(agentSettings),
        baseUrl,
        auth.token,
        auth.tokenData.organizationId
      );

      // Fetch enabled skills with content for worker filesystem sync
      let skillsConfig: Array<{ name: string; content: string }> = [];
      const mcpContext: Record<string, string> = {};
      if (this.agentSettingsStore && agentId) {
        try {
          const settings =
            await this.agentSettingsStore.getSettings(agentId);
          const skills = settings?.skillsConfig?.skills || [];
          skillsConfig = skills
            .filter((s) => s.enabled && s.content)
            .map((s) => ({ name: s.name, content: s.content! }));
        } catch (error) {
          logger.error("Failed to fetch skills config for worker sync", {
            error,
          });
        }
      }

      const mergedSkillsInstructions = contextData.skillsInstructions || "";

      logger.info(
        `Session context for ${userId}: ${Object.keys(mcpConfig.mcpServers || {}).length} MCPs, ${contextData.agentInstructions.length} chars agent instructions, ${contextData.platformInstructions.length} chars platform instructions, ${contextData.networkInstructions.length} chars network instructions, ${mergedSkillsInstructions.length} chars skills instructions, ${enrichedMcpStatus.length} MCP status entries, ${Object.keys(mcpTools).length} MCP tool lists, ${Object.keys(mcpInstructions).length} MCP instructions, ${skillsConfig.length} skills, provider: ${providerConfig.defaultProvider || "none"}`
      );

      return c.json({
        mcpConfig,
        agentInstructions: contextData.agentInstructions,
        platformInstructions: contextData.platformInstructions,
        networkInstructions: contextData.networkInstructions,
        skillsInstructions: mergedSkillsInstructions,
        mcpStatus: enrichedMcpStatus,
        mcpTools,
        mcpInstructions,
        mcpContext,
        providerConfig,
        skillsConfig,
      });
    } catch (error) {
      logger.error("Failed to generate session context", { err: error });
      return c.json({ error: "session_context_error" }, 500);
    }
  }

  private async authenticateWorker(
    c: Context
  ): Promise<{ tokenData: WorkerTokenData; token: string } | null> {
    const authHeader = c.req.header("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);
    const tokenData = verifyWorkerToken(token);

    if (!tokenData) {
      logger.warn("Invalid token");
      return null;
    }

    if (
      tokenData.jti &&
      (await getRevokedTokenStore().isRevoked(tokenData.jti))
    ) {
      logger.warn("Revoked worker token");
      return null;
    }

    return { tokenData, token };
  }

  /**
   * Mint a fresh same-claims token from a currently-valid one, so a >2h turn
   * doesn't die when its token hits the 2h TTL (the short TTL is the leak-
   * revocation path; this swaps the token without lengthening it).
   *
   * Contract: requires a valid per-run token (`runId` + `messageId`) AND a live
   * turn-timeout marker for the token's OWN turn ({@link hasLiveTurnForMessage}
   * on `(deploymentName, messageId)`). Gating per-turn — not per-deployment —
   * is the load-bearing invariant: it closes the cross-turn leak where a still-
   * valid token from a COMPLETED turn refreshes off a later, unrelated turn's
   * liveness on the same deployment. Expired (verifyWorkerToken) and jti-revoked
   * tokens are rejected before the gate; the fresh token gets its own jti.
   * Legacy direct-enqueue tokens (no runId/messageId → no marker) are denied.
   */
  private async handleTokenRefresh(c: Context): Promise<Response> {
    const auth = await this.authenticateWorker(c);
    if (!auth) {
      // Expired / malformed / jti-revoked — verifyWorkerToken or the
      // revoked-token check already rejected. An expired token CANNOT refresh
      // itself; that bounds the leak window.
      return c.json({ error: "Invalid token" }, 401);
    }
    const { tokenData } = auth;

    // No runId/messageId → no turn-timeout marker exists for this token's work,
    // so we have no per-turn liveness signal. Deny rather than mint blind.
    if (typeof tokenData.runId !== "number" || !tokenData.messageId) {
      return c.json({ error: "Token not eligible for refresh" }, 403);
    }

    if (!tokenData.deploymentName) {
      return c.json({ error: "Token missing deployment scope" }, 400);
    }

    const live = await hasLiveTurnForMessage(
      tokenData.deploymentName,
      tokenData.messageId
    );
    if (!live) {
      // THIS token's turn has no in-flight marker — the turn is terminal (reply
      // committed, worker died, or deadline swept), even if a later unrelated
      // turn on the same deployment is still live. Refusing here is the
      // revocation property: the token chain ends with the turn it was minted
      // for, so a completed turn's token can't piggyback on a newer turn.
      logger.info(
        {
          deploymentName: tokenData.deploymentName,
          runId: tokenData.runId,
          messageId: tokenData.messageId,
        },
        "Token refresh denied: no live turn for this message"
      );
      return c.json({ error: "No live turn for token" }, 403);
    }

    // Mint a fresh token with identical claims (fresh timestamp + new jti).
    const refreshed = generateWorkerToken(
      tokenData.userId,
      tokenData.conversationId,
      tokenData.deploymentName,
      {
        channelId: tokenData.channelId,
        teamId: tokenData.teamId,
        agentId: tokenData.agentId,
        organizationId: tokenData.organizationId,
        connectionId: tokenData.connectionId,
        platform: tokenData.platform,
        source: tokenData.source,
        sessionKey: tokenData.sessionKey,
        traceId: tokenData.traceId,
        runId: tokenData.runId,
        messageId: tokenData.messageId,
        // Preserve the builder admin-tool allowlist across refresh — otherwise a
        // long system-agent turn loses its admin grant when the token rotates.
        adminTools: tokenData.adminTools,
      }
    );

    logger.info(
      {
        deploymentName: tokenData.deploymentName,
        runId: tokenData.runId,
        messageId: tokenData.messageId,
      },
      "Issued refreshed worker token"
    );
    return c.json({ token: refreshed });
  }

  private getRequestBaseUrl(c: Context): string {
    const forwardedProto = c.req.header("x-forwarded-proto");
    const protocolCandidate = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto?.split(",")[0];
    const protocol = (protocolCandidate || "http").trim();
    const host = c.req.header("host");
    if (host) {
      // Preserve any base path from publicGatewayUrl (e.g. /lobu) when the
      // gateway is mounted as a sub-app under a prefix path.
      let basePath = "";
      try {
        basePath = new URL(this.publicGatewayUrl).pathname.replace(/\/$/, "");
      } catch {
        // publicGatewayUrl may not be a full URL in some configurations.
      }
      return `${protocol}://${host}${basePath}`;
    }
    return this.publicGatewayUrl;
  }

  /**
   * Resolve dynamic provider configuration for a given agent.
   * Mirrors the provider resolution logic in deployment-manager's
   * generateEnvironmentVariables() but returns config values instead of env vars.
   */
  private async resolveProviderConfig(
    agentId: string,
    agentModel?: string,
    requestBaseUrl?: string,
    workerToken?: string,
    organizationId?: string
  ): Promise<{
    credentialEnvVarName?: string;
    defaultProvider?: string;
    defaultProviderSlug?: string;
    defaultModel?: string;
    cliBackends?: Array<{
      providerId: string;
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      modelArg?: string;
      sessionArg?: string;
    }>;
    providerBaseUrlMappings?: Record<string, string>;
    configProviders?: Record<string, ConfigProviderMeta>;
  }> {
    if (!this.providerCatalogService || !agentId) {
      return {};
    }

    const effectiveProviders =
      await this.providerCatalogService.getInstalledModules(agentId);
    if (effectiveProviders.length === 0) {
      return {};
    }

    // Determine primary provider
    let primaryProvider = agentModel
      ? await this.providerCatalogService.findProviderForModel(
          agentModel,
          effectiveProviders
        )
      : undefined;

    if (!primaryProvider) {
      for (const candidate of effectiveProviders) {
        if (
          candidate.hasSystemKey() ||
          (await candidate.hasCredentials(agentId, { organizationId }))
        ) {
          primaryProvider = candidate;
          break;
        }
      }
    }

    // Build proxy base URL mappings for all installed providers
    // Use the request base URL (the worker's DISPATCHER_URL) for internal routing
    const proxyBaseUrl = `${requestBaseUrl || this.publicGatewayUrl}/api/proxy`;
    const providerBaseUrlMappings: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      Object.assign(
        providerBaseUrlMappings,
        provider.getProxyBaseUrlMappings(proxyBaseUrl, agentId)
      );
    }

    // Build CLI backend configs
    const cliBackends: Array<{
      providerId: string;
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      modelArg?: string;
      sessionArg?: string;
    }> = [];
    for (const provider of effectiveProviders) {
      const config = provider.getCliBackendConfig?.();
      if (config) {
        cliBackends.push({ providerId: provider.providerId, ...config });
      }
    }

    // Collect metadata from config-driven providers for worker model resolution
    const configProviders: Record<string, ConfigProviderMeta> = {};
    for (const provider of effectiveProviders) {
      const meta = (provider as ApiKeyProviderModule).getProviderMetadata?.();
      if (meta) {
        configProviders[provider.providerId] = meta;
      }
    }

    // Build credential placeholders for proxy mode — in-process workers need
    // these so the runtime doesn't reject requests before they reach the proxy.
    // Providers that authenticate via the worker JWT (e.g. Bedrock) receive
    // the worker token so their placeholder *is* a verifiable credential.
    const credentialPlaceholders: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      if (
        provider.hasSystemKey() ||
        (await provider.hasCredentials(agentId, { organizationId }))
      ) {
        const credVar = provider.getCredentialEnvVarName();
        const placeholder = provider.buildCredentialPlaceholder
          ? await provider.buildCredentialPlaceholder(agentId, { workerToken })
          : "lobu-proxy";
        credentialPlaceholders[credVar] = placeholder;
      }
    }

    const result: {
      credentialEnvVarName?: string;
      defaultProvider?: string;
      defaultProviderSlug?: string;
      defaultModel?: string;
      cliBackends?: typeof cliBackends;
      providerBaseUrlMappings?: Record<string, string>;
      configProviders?: typeof configProviders;
      credentialPlaceholders?: Record<string, string>;
    } = {};

    if (primaryProvider) {
      result.credentialEnvVarName = primaryProvider.getCredentialEnvVarName();
      const upstream = primaryProvider.getUpstreamConfig?.();
      result.defaultProvider = upstream?.slug || primaryProvider.providerId;
      // The worker is told `defaultProvider` is the UPSTREAM slug (e.g.
      // "anthropic") and only strips a `<defaultProvider>/` model prefix. But
      // Lobu stores models under the provider's LOBU id (e.g.
      // "claude/claude-opus-4-8"), so for a provider whose Lobu id differs from
      // its upstream slug the prefix is never stripped and reaches the provider
      // API verbatim → 404. Hand the worker the Lobu slug too so it can strip
      // that prefix as well (see resolveModelRef). Omitted when the slugs match.
      if (upstream?.slug && upstream.slug !== primaryProvider.providerId) {
        result.defaultProviderSlug = primaryProvider.providerId;
      }
    }

    // Only an explicitly configured model is used — Lobu no longer silently
    // resolves a provider default (the worker errors with an actionable
    // "select a model" message when none is set). A concrete model is chosen at
    // config time via the model picker (getModelOptions).
    if (agentModel) {
      result.defaultModel = agentModel;
    }

    if (Object.keys(providerBaseUrlMappings).length > 0) {
      result.providerBaseUrlMappings = providerBaseUrlMappings;
    }

    if (cliBackends.length > 0) {
      result.cliBackends = cliBackends;
    }

    if (Object.keys(configProviders).length > 0) {
      result.configProviders = configProviders;
    }

    if (Object.keys(credentialPlaceholders).length > 0) {
      result.credentialPlaceholders = credentialPlaceholders;
    }

    return result;
  }

  /**
   * Shutdown gateway
   */
  shutdown(): void {
    this.connectionManager.shutdown();
    this.jobRouter.shutdown();
  }
}
