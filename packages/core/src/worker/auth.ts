import { createLogger } from "../logger";
import { decrypt, encrypt } from "../utils/encryption";

const logger = createLogger("worker-auth");

/**
 * Worker authentication using encrypted thread ID
 * Token format: encrypted(userId:threadId:deploymentName:timestamp)
 */

export interface WorkerTokenData {
  userId: string;
  threadId: string;
  channelId: string;
  teamId?: string; // Optional - not all platforms have teams
  agentId?: string; // Space ID for multi-tenant isolation
  deploymentName: string;
  timestamp: number;
  platform?: string;
  sessionKey?: string;
  traceId?: string; // Trace ID for end-to-end observability
}

/**
 * Generate a worker authentication token by encrypting thread metadata
 */
export function generateWorkerToken(
  userId: string,
  threadId: string,
  deploymentName: string,
  options: {
    channelId: string;
    teamId?: string;
    agentId?: string;
    platform?: string;
    sessionKey?: string;
    traceId?: string; // Trace ID for end-to-end observability
  }
): string {
  // Validate required fields
  if (!options.channelId) {
    throw new Error("channelId is required for worker token generation");
  }

  const timestamp = Date.now();
  const payload: WorkerTokenData = {
    userId,
    threadId,
    channelId: options.channelId,
    teamId: options.teamId, // Can be undefined - that's ok
    agentId: options.agentId, // Space ID for multi-tenant credential lookup
    deploymentName,
    timestamp,
    platform: options.platform,
    sessionKey: options.sessionKey,
    traceId: options.traceId, // Trace ID for observability
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

    // No expiration check - workers are ephemeral and short-lived
    return data;
  } catch (error) {
    logger.error("Error verifying token:", error);
    return null;
  }
}
