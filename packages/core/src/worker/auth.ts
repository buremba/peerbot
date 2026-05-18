import { randomUUID } from "node:crypto";
import { createLogger } from "../logger";
import { decrypt, encrypt } from "../utils/encryption";

const logger = createLogger("worker-auth");

/**
 * Worker authentication using encrypted conversation ID.
 * Token format: encrypted(JSON payload of thread metadata).
 */

export interface WorkerTokenData {
  userId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  /**
   * Owning organization of the agent the token was minted for. Used by the
   * HTTP proxy to scope per-tenant caches (e.g. egress-judge verdict cache)
   * so org A's decisions can never satisfy org B's requests. Optional only
   * because some internal/preflight call sites mint tokens before the owning
   * org has been resolved; production agent runs always set it.
   */
  organizationId?: string;
  connectionId?: string;
  deploymentName: string;
  timestamp: number;
  platform?: string;
  sessionKey?: string;
  traceId?: string;
  /** Unique token ID — enables targeted revocation. */
  jti?: string;
}

export function generateWorkerToken(
  userId: string,
  conversationId: string,
  deploymentName: string,
  options: {
    channelId: string;
    teamId?: string;
    agentId?: string;
    organizationId?: string;
    connectionId?: string;
    platform?: string;
    sessionKey?: string;
    traceId?: string;
  }
): string {
  if (!options.channelId) {
    throw new Error("channelId is required for worker token generation");
  }

  const payload: WorkerTokenData = {
    userId,
    conversationId,
    channelId: options.channelId,
    teamId: options.teamId,
    agentId: options.agentId,
    organizationId: options.organizationId,
    connectionId: options.connectionId,
    deploymentName,
    timestamp: Date.now(),
    platform: options.platform,
    sessionKey: options.sessionKey,
    traceId: options.traceId,
    jti: randomUUID(),
  };

  return encrypt(JSON.stringify(payload));
}

function parsePositiveIntEnv(
  name: string,
  fallback: number,
  allowZero = false
): number {
  const raw = parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(raw)) return fallback;
  if (allowZero ? raw < 0 : raw <= 0) return fallback;
  return raw;
}

/**
 * Verify and decrypt a worker authentication token
 */
export function verifyWorkerToken(token: string): WorkerTokenData | null {
  try {
    const parsed: unknown = JSON.parse(decrypt(token));

    // Decrypted plaintext is attacker-influenced — `as` would coerce `null`,
    // an array, a string, or a number into `WorkerTokenData` and let
    // downstream consumers TypeError off undefined fields. Validate shape
    // before treating it as a payload.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.error("Worker token rejected: payload is not a plain object");
      return null;
    }
    const data = parsed as WorkerTokenData;

    if (
      typeof data.conversationId !== "string" ||
      !data.conversationId ||
      typeof data.userId !== "string" ||
      !data.userId ||
      typeof data.deploymentName !== "string" ||
      !data.deploymentName ||
      typeof data.timestamp !== "number" ||
      !data.timestamp
    ) {
      logger.error(
        "Worker token rejected: missing or wrongly-typed required fields"
      );
      return null;
    }

    // Default TTL 2h (was 24h — a leaked token had no revocation path for a
    // full day). Override via WORKER_TOKEN_TTL_MS. Clock-skew tolerance via
    // WORKER_TOKEN_CLOCK_SKEW_MS. Tokens timestamped further in the future
    // than the skew are rejected too — otherwise forward drift would grant
    // an unbounded validity window.
    const ttl = parsePositiveIntEnv("WORKER_TOKEN_TTL_MS", 2 * 60 * 60 * 1000);
    const skewMs = parsePositiveIntEnv(
      "WORKER_TOKEN_CLOCK_SKEW_MS",
      30 * 1000,
      true
    );
    const age = Date.now() - data.timestamp;
    if (age > ttl + skewMs) {
      logger.error("Worker token rejected: expired");
      return null;
    }
    if (-age > skewMs) {
      logger.error("Worker token rejected: timestamp in the future");
      return null;
    }

    return data;
  } catch (error) {
    // Pino expects `(obj, msg)` for Error serialization. The previous
    // `(msg, error)` form fell through to message-only logging and rendered
    // the actual decryption / parse error as `{}`, hiding the real cause.
    logger.error(
      {
        err:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
      },
      "Error verifying token"
    );
    return null;
  }
}
