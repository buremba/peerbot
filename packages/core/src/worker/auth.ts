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
  /**
   * Headless run origin (`platformMetadata.source`, e.g. watcher-run /
   * scheduled-job / connector-repair / internal). Carried so interaction
   * cards emitted from a headless turn can be stamped headless and exempted
   * from the SSE-owner gate — no browser SSE connection exists on any pod for
   * a headless run, so an owner-gated card would dead-letter. Absent for
   * interactive (browser-driven) runs.
   */
  source?: string;
  sessionKey?: string;
  traceId?: string;
  /** Unique token ID — enables targeted revocation. */
  jti?: string;
  /**
   * Optional `runs.id` this token is scoped to. Present only on per-job
   * tokens minted by the runs queue dispatcher at thread-message time;
   * the deployment-lifetime WORKER_TOKEN minted at spawn time does NOT
   * carry it. The snapshot route requires equality between this field
   * and the request body's `runId` so a worker bearing a same-(org,
   * agent, conv) token cannot POST under a different run's slot —
   * codex round 2, finding A on PR #865.
   */
  runId?: number;
  /**
   * Per-turn message id this token's work was dispatched for. Set alongside
   * {@link runId} by the runs-queue dispatcher (MessageConsumer.handleMessage),
   * which arms the turn-timeout marker with the SAME `messageId`. The token
   * refresh gate uses it to require a live marker for THIS turn specifically
   * (`deploymentName:messageId`), not merely any live turn on the deployment —
   * otherwise a still-valid token from a completed turn could refresh while a
   * later, unrelated turn on the same deployment is live. Long-lived deployment
   * tokens do NOT carry it.
   */
  messageId?: string;
  /**
   * Per-turn allowlist of internal admin tool NAMES this token may call.
   * Set ONLY for the org's builder/system agent (id === organization.
   * system_agent_id) when the human driving the turn is an org owner/admin
   * (see `resolveBuilderAdminTools`). Enforced exact-name at the execute gate
   * (`tools/execute.ts`); absent for every normal agent/turn, so a forged or
   * normal token grants no admin access.
   */
  adminTools?: string[];
  /**
   * Selected runtime-provider id (e.g. "vercel"), resolved from the agent's
   * environment at token-mint time. The generic `/internal/runtime/exec` route
   * trusts THIS signed claim to pick the gateway-side provider — the worker
   * never names a provider over the wire, so a compromised worker cannot reach
   * a provider/credential its org didn't configure. Absent → the worker runs
   * its in-process just-bash backend (no remote runtime).
   */
  runtimeProviderId?: string;
  /**
   * The `environments.id` whose vault credential backs {@link runtimeProviderId}
   * (rows `environment:<id>:<field>`). Absent → gateway resolves the provider
   * credential from system env only. Set together with `runtimeProviderId`.
   */
  environmentId?: string;
  /**
   * Egress allowlist (the agent's resolved `networkConfig.allowedDomains`) for a
   * remote runtime sandbox. Carried as a SIGNED claim — set gateway-side at mint
   * from the agent's network config — because the generic `/internal/runtime/exec`
   * route must NOT trust a worker-supplied list: the worker is the sandbox-ee, so
   * a compromised one could send `["*"]` and get an allow-all sandbox, bypassing
   * egress policy. Absent/empty → the sandbox is `deny-all` (fail closed).
   */
  allowedDomains?: string[];
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
    /** Headless run origin — see WorkerTokenData.source. */
    source?: string;
    sessionKey?: string;
    traceId?: string;
    /**
     * Bind the token to a single `runs.id`. Set only by the runs-queue
     * dispatcher's per-job token mint (MessageConsumer.handleMessage on
     * the gateway side). Long-lived deployment tokens must NOT pass this
     * — they'd be wrong for subsequent runs. See WorkerTokenData.runId
     * for the consumption contract.
     */
    runId?: number;
    /**
     * Per-turn message id, set alongside `runId` by the runs-queue dispatcher.
     * Binds token refresh to this turn's own liveness marker. See
     * WorkerTokenData.messageId.
     */
    messageId?: string;
    /**
     * Builder admin-tool allowlist for this turn. See WorkerTokenData.adminTools.
     */
    adminTools?: string[];
    /** Selected runtime provider id. See WorkerTokenData.runtimeProviderId. */
    runtimeProviderId?: string;
    /** Selected environment id backing the runtime credential. See WorkerTokenData.environmentId. */
    environmentId?: string;
    /** Resolved egress allowlist for a remote runtime sandbox. See WorkerTokenData.allowedDomains. */
    allowedDomains?: string[];
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
    source: options.source,
    sessionKey: options.sessionKey,
    traceId: options.traceId,
    jti: randomUUID(),
    runId: options.runId,
    messageId: options.messageId,
    adminTools: options.adminTools,
    runtimeProviderId: options.runtimeProviderId,
    environmentId: options.environmentId,
    allowedDomains: options.allowedDomains,
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
    // `runId` is optional but must be a positive integer when present.
    // A forged token with `runId: "*"` (or NaN, or negative) would pass
    // the verification check and then defeat the snapshot route's
    // equality check below if downstream code compared loosely.
    if (data.runId !== undefined) {
      if (
        typeof data.runId !== "number" ||
        !Number.isInteger(data.runId) ||
        data.runId <= 0
      ) {
        logger.error("Worker token rejected: runId must be a positive integer");
        return null;
      }
    }
    // `adminTools` is optional but must be a string[] when present — a forged
    // token with a non-array (or non-string elements) must be rejected, not
    // coerced, before the execute gate trusts it to allow internal tools.
    if (data.adminTools !== undefined) {
      if (
        !Array.isArray(data.adminTools) ||
        !data.adminTools.every((t) => typeof t === "string")
      ) {
        logger.error("Worker token rejected: adminTools must be a string[]");
        return null;
      }
    }
    // `runtimeProviderId` / `environmentId` are optional but, when present, the
    // runtime route trusts them to pick a provider + vault credential. A forged
    // token with a non-string here must be rejected, not coerced.
    if (
      data.runtimeProviderId !== undefined &&
      typeof data.runtimeProviderId !== "string"
    ) {
      logger.error("Worker token rejected: runtimeProviderId must be a string");
      return null;
    }
    if (
      data.environmentId !== undefined &&
      typeof data.environmentId !== "string"
    ) {
      logger.error("Worker token rejected: environmentId must be a string");
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
