/**
 * Agent thread service — programmatic counterparts to the public HTTP routes
 * `POST /api/v1/agents` (create thread/session) and `POST
 * /api/v1/agents/:agentId/messages` (enqueue message).
 *
 * The HTTP routes in `routes/public/agent.ts` delegate the underlying work
 * (session minting, queue enqueue) to these functions so that internal
 * callers — for example the worker-completion path in `server` —
 * can open threads and post messages without going through HTTP.
 *
 * The functions here intentionally do NOT perform any HTTP-shaped auth
 * (settings session, worker-token, OAuth, …). Callers are
 * presumed to be inside the gateway's trust boundary; the public routes
 * remain the single auth-gated entry point for external clients.
 */
import { randomUUID } from "node:crypto";
import { createLogger, generateWorkerToken } from "@lobu/core";
import type { QueueProducer } from "../infrastructure/queue/queue-producer.js";
import type { ISessionManager, ThreadSession } from "../session.js";

const logger = createLogger("agent-threads");

/**
 * Arguments for `createThreadForAgent`.
 *
 * Mirrors the shape of `POST /api/v1/agents` for the fields it needs to mint
 * a session, but with no notion of provider/model/network/MCP overrides:
 * internal callers always inherit the agent's stored settings.
 */
export interface CreateThreadForAgentArgs {
  /** Target agent id. The session and resulting thread will be scoped to this agent. */
  agentId: string;
  /** Owning organization id (informational; persisted onto the session). */
  organizationId: string;
  /** Optional human-recorded principal that triggered the open. */
  createdByUserId?: string;
  /** Free-form reason tag for log lines (e.g. "connector-repair"). */
  reason?: string;
  /**
   * Optional caller-supplied id for the new thread. Lets callers mint the id
   * BEFORE writing it to their own state (e.g. an atomic UPDATE that wins
   * against racing workers) and only then commit the session.
   */
  externalThreadId?: string;
  /** User id to attribute the thread to. Defaults to `agentId`. */
  userId?: string;
}

export interface CreateThreadForAgentResult {
  /** Thread / session identifier (also referred to as `conversationId`). */
  threadId: string;
  /** Worker token usable by the caller's HTTP client (rarely needed internally). */
  token: string;
  /** Token expiration timestamp (ms since epoch). */
  expiresAt: number;
}

const TOKEN_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Mint a new thread session for an agent.
 *
 * Returns the threadId (== conversationId) without enqueueing any message.
 * Callers wire follow-up state (e.g. `feeds.repair_thread_id = $threadId`)
 * and then call {@link enqueueAgentMessage} to post the first message.
 */
export async function createThreadForAgent(
  deps: { sessionManager: ISessionManager },
  args: CreateThreadForAgentArgs
): Promise<CreateThreadForAgentResult> {
  const { sessionManager } = deps;
  const { agentId, reason, externalThreadId } = args;
  const userId = args.userId || args.createdByUserId || agentId;

  const threadId = externalThreadId || randomUUID();
  const conversationId = `${agentId}_${userId}_${threadId}`;
  const channelId = `api_${userId}`;
  const deploymentName = `api-${agentId.slice(0, 8)}`;

  const token = generateWorkerToken(agentId, conversationId, deploymentName, {
    channelId,
    agentId,
    platform: "api",
    sessionKey: userId,
  });
  const expiresAt = Date.now() + TOKEN_EXPIRATION_MS;

  const session: ThreadSession = {
    conversationId,
    channelId,
    userId,
    threadCreator: userId,
    lastActivity: Date.now(),
    createdAt: Date.now(),
    status: "created",
    provider: "claude",
    agentId,
    dryRun: false,
    isEphemeral: false,
  };
  await sessionManager.setSession(session);

  logger.info(
    `Created thread ${conversationId} for agent ${agentId}${reason ? ` (reason=${reason})` : ""}`
  );

  return { threadId: conversationId, token, expiresAt };
}

export interface EnqueueAgentMessageArgs {
  /** Thread id (conversationId) returned by `createThreadForAgent`. */
  threadId: string;
  /** Plain-text user message body. */
  messageText: string;
  /** Optional caller-supplied messageId (defaults to a fresh UUID). */
  messageId?: string;
  /** Free-form source tag for log lines / platformMetadata. */
  source?: string;
}

export interface EnqueueAgentMessageResult {
  messageId: string;
  jobId: string;
}

/**
 * Enqueue a message into an existing agent thread.
 *
 * Mirrors the direct-API path of `POST /api/v1/agents/:agentId/messages`:
 * resolves the session, touches it, and dispatches a `MessagePayload` to
 * the unified message queue. Throws if the thread does not exist.
 */
export async function enqueueAgentMessage(
  deps: { sessionManager: ISessionManager; queueProducer: QueueProducer },
  args: EnqueueAgentMessageArgs
): Promise<EnqueueAgentMessageResult> {
  const { sessionManager, queueProducer } = deps;
  const { threadId, messageText } = args;
  const messageId = args.messageId || randomUUID();

  const session = await sessionManager.getSession(threadId);
  if (!session) {
    throw new Error(`Thread ${threadId} not found`);
  }

  await sessionManager.touchSession(threadId);

  const realAgentId = session.agentId || threadId;
  const channelId = session.channelId || `api_${session.userId}`;

  const jobId = await queueProducer.enqueueMessage({
    userId: session.userId,
    conversationId: session.conversationId || threadId,
    messageId,
    channelId,
    teamId: "api",
    agentId: realAgentId,
    botId: "lobu-api",
    platform: "api",
    messageText,
    platformMetadata: {
      agentId: realAgentId,
      source: args.source || "internal",
      dryRun: session.dryRun || false,
    },
    agentOptions: {
      provider: session.provider || "claude",
      model: session.model,
    },
    networkConfig: session.networkConfig,
    mcpConfig: session.mcpConfig,
  });

  return { messageId, jobId };
}
