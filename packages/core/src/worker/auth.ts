import { createLogger } from "../logger";
import { decrypt, encrypt } from "../utils/encryption";

const logger = createLogger("worker-auth");

/**
 * Worker authentication using encrypted conversation ID
 * Token format: encrypted(userId:conversationId:deploymentName:timestamp)
 */

export interface WorkerTokenData {
  userId: string;
  conversationId: string;
  channelId: string;
  teamId?: string; // Optional - not all platforms have teams
  agentId?: string; // Space ID for multi-tenant isolation
  connectionId?: string;
  deploymentName: string;
  timestamp: number;
  platform?: string;
  sessionKey?: string;
  traceId?: string; // Trace ID for end-to-end observability
  // Approver-routed consent target. Populated for scheduled fires whose
  // schedule declares `approver = "<platform>:<connectionSlug>:<channelId>[:<threadTs>]"`.
  // When set, blocked tool calls post the approval card to this target
  // instead of being silently dropped (headless mode).
  approverChannelId?: string;
  approverConnectionId?: string;
  approverTeamId?: string;
  approverPlatform?: string;
  approverConversationId?: string;
}

/**
 * Generate a worker authentication token by encrypting thread metadata
 */
export function generateWorkerToken(
  userId: string,
  conversationId: string,
  deploymentName: string,
  options: {
    channelId: string;
    teamId?: string;
    agentId?: string;
    connectionId?: string;
    platform?: string;
    sessionKey?: string;
    traceId?: string; // Trace ID for end-to-end observability
    approverChannelId?: string;
    approverConnectionId?: string;
    approverTeamId?: string;
    approverPlatform?: string;
    approverConversationId?: string;
  }
): string {
  // Validate required fields
  if (!options.channelId) {
    throw new Error("channelId is required for worker token generation");
  }

  const timestamp = Date.now();
  const payload: WorkerTokenData = {
    userId,
    conversationId,
    channelId: options.channelId,
    teamId: options.teamId, // Can be undefined - that's ok
    agentId: options.agentId, // Space ID for multi-tenant credential lookup
    connectionId: options.connectionId,
    deploymentName,
    timestamp,
    platform: options.platform,
    sessionKey: options.sessionKey,
    traceId: options.traceId, // Trace ID for observability
    approverChannelId: options.approverChannelId,
    approverConnectionId: options.approverConnectionId,
    approverTeamId: options.approverTeamId,
    approverPlatform: options.approverPlatform,
    approverConversationId: options.approverConversationId,
  };

  // Encrypt the payload
  const encrypted = encrypt(JSON.stringify(payload));
  return encrypted;
}

/**
 * Verify and decrypt a worker authentication token
 */
export function verifyWorkerToken(token: string): WorkerTokenData | null {
  try {
    // Decrypt the token
    const decrypted = decrypt(token);
    const data = JSON.parse(decrypted) as WorkerTokenData;

    if (
      !data.conversationId ||
      !data.userId ||
      !data.deploymentName ||
      !data.timestamp
    ) {
      logger.error("Worker token rejected: missing required fields");
      return null;
    }

    // Check token expiration (default 24h)
    const parsedTtl = parseInt(process.env.WORKER_TOKEN_TTL_MS ?? "", 10);
    const ttl =
      !Number.isNaN(parsedTtl) && parsedTtl > 0 ? parsedTtl : 86400000;
    if (Date.now() - data.timestamp > ttl) {
      logger.error("Worker token rejected: expired");
      return null;
    }

    return data;
  } catch (error) {
    logger.error("Error verifying token:", error);
    return null;
  }
}
