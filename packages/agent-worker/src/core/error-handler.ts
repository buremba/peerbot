import {
  type AgentErrorContext,
  AgentErrorCode,
  createLogger,
  getSentry,
  type WorkerTransport,
} from "@lobu/core";
import { getProviderAuthHintFromError } from "../shared/provider-auth-hints";

const logger = createLogger("worker");

/**
 * Context threaded from `worker.ts` so a captured provider/model failure
 * carries the tags that make "openai doesn't work" triageable in Sentry.
 */
interface ExecutionErrorContext {
  provider?: string;
  model?: string;
  agentId?: string;
  runId?: number | string;
}

/**
 * Format the crash delta for an UNCLASSIFIED failure only. Classified errors
 * are rendered by the gateway from `AGENT_ERRORS`, not here — see
 * `handleExecutionError`.
 */
function formatErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return `💥 Worker crashed: Unknown error`;
  }
  const name = error.constructor.name;
  const isGeneric = name === "Error" || name === "WorkspaceError";
  return isGeneric
    ? `💥 Worker crashed: ${error.message}`
    : `💥 Worker crashed (${name}): ${error.message}`;
}

/**
 * Sentinel thrown by the worker when a session exceeds its time budget
 * (exit code 124). The run is retried automatically by the gateway, so the
 * timeout must NOT surface to the user as a crash — we only signal the error
 * for bookkeeping/cleanup.
 */
const SESSION_TIMEOUT_MESSAGE = "SESSION_TIMEOUT";

/**
 * Classified codes whose user-facing "💥 Worker crashed" delta is intentionally
 * suppressed: SESSION_TIMEOUT is retried silently, and NO_MODEL_CONFIGURED has a
 * dedicated upstream user message. PROVIDER_* codes are NOT in this set — they
 * must still surface a crash delta to the user when they reach the catch-all.
 */
const SILENT_DELTA_CODES = new Set<string>([
  AgentErrorCode.SESSION_TIMEOUT,
  AgentErrorCode.NO_MODEL_CONFIGURED,
]);

/**
 * Pull a human reset time out of a provider quota error so the rendered
 * message can tell the user when they can retry. z.ai's 429 body is
 * "…Your limit will reset at 2026-07-10 04:32:47". Returns undefined when no
 * timestamp is present (the message still classifies as quota-exhausted).
 */
function extractResetAt(message: string): string | undefined {
  const m = message.match(
    /reset(?:s| at| will reset at)?\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(?::[0-9]{2})?)/i
  );
  return m?.[1];
}

/**
 * THE classifier: message → { code, context }. This is the single source of
 * truth for turning a raw worker/provider failure into a catalog code — every
 * other layer (worker failure branch, Sentry tagging, the gateway renderers)
 * consumes this rather than re-implementing its own regex. Adding a failure
 * mode = one pattern here + one entry in `AGENT_ERRORS`.
 */
export function classifyAgentError(error: unknown): {
  code?: AgentErrorCode;
  context: AgentErrorContext;
} {
  const context: AgentErrorContext = {};
  if (!(error instanceof Error)) return { context };
  const message = error.message;

  if (message === SESSION_TIMEOUT_MESSAGE)
    return { code: AgentErrorCode.SESSION_TIMEOUT, context };

  // Provider usage/rate limit. Covers z.ai's "429 Weekly/Monthly Limit
  // Exhausted", generic rate-limit/quota phrasings, and a bare 429. Placed
  // before PROVIDER_AUTH because a rate-limited request can also echo auth-ish
  // words; the quota shape is the more specific, more actionable signal.
  if (
    /weekly\/monthly limit exhausted|limit exhausted|rate[-\s]?limit|quota (?:exceeded|exhausted)|too many requests|\b429\b|resource_exhausted/i.test(
      message
    )
  ) {
    const resetAt = extractResetAt(message);
    if (resetAt) context.resetAt = resetAt;
    return { code: AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED, context };
  }

  if (
    message.includes("No model configured") ||
    message.includes("No model selected") ||
    // model-resolver.ts throws "No model resolved for this run…" when no
    // default/per-behavior/org model is set. Was previously UNCLASSIFIED — it
    // dodged the catalog and surfaced as a raw "💥 Worker crashed" instead of
    // the actionable "connect a provider" guidance.
    message.includes("No model resolved") ||
    message.includes("No provider specified")
  )
    return { code: AgentErrorCode.NO_MODEL_CONFIGURED, context };
  // Reuse the canonical provider-auth regex (provider-auth-hints.ts) so the
  // classification matches the same auth-failure strings the worker already
  // detects elsewhere.
  if (getProviderAuthHintFromError(message))
    return { code: AgentErrorCode.PROVIDER_AUTH, context };
  // The gateway secret-proxy 401s with "No provider credentials configured"
  // (code no_credentials) when every credential tier misses. The live red-test
  // (LOBU-BACKEND-W) landed as `unclassified` because the auth-hint regex
  // doesn't cover this shape — and an unclassified event dodges the
  // PROVIDER_* Sentry alert.
  if (
    /no\s+(provider\s+)?credentials\s+configured|no_credentials/i.test(message)
  )
    return { code: AgentErrorCode.PROVIDER_AUTH, context };
  // `worker.ts` throws "Model \"<id>\" not found for provider ..." and pi-ai /
  // upstream surface "<x> is not a valid model"/"unknown model"/"model ... not found".
  if (/not a valid model|unknown model|model .* not found/i.test(message))
    return { code: AgentErrorCode.PROVIDER_UNKNOWN_MODEL, context };
  // model-resolver.ts / session-runner.ts throw this when a non-OpenAI
  // provider cannot be routed through the Lobu gateway proxy. This is usually a
  // provider/model configuration issue, not an agent crash.
  if (
    /Could not resolve a base URL for provider/i.test(message) ||
    /provider is not connected to this agent/i.test(message) ||
    /did not receive the gateway routing URL/i.test(message)
  )
    return { code: AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED, context };
  return { context };
}

/**
 * Back-compat thin wrapper returning just the code string. Callers that only
 * need the classification for Sentry tagging / silent-delta gating use this;
 * anything that renders a user message should use `classifyAgentError` to also
 * get the context (resetAt, provider).
 */
export function classifyError(error: unknown): string | undefined {
  return classifyAgentError(error).code;
}

export async function handleExecutionError(
  error: unknown,
  transport: WorkerTransport,
  ctx?: ExecutionErrorContext
): Promise<void> {
  logger.error("Worker execution failed:", error);

  const { code, context } = classifyAgentError(error);
  const errorInstance =
    error instanceof Error ? error : new Error(String(error));

  // Report to Sentry Issues. `getSentry()` is DSN-gated and returns null when
  // the worker was spawned without SENTRY_DSN, so this is a safe no-op in dev /
  // self-host. SESSION_TIMEOUT is retried silently — capturing it would be pure
  // noise — so it's the one classification we skip.
  if (code !== AgentErrorCode.SESSION_TIMEOUT) {
    getSentry()?.captureException(errorInstance, {
      tags: {
        provider: ctx?.provider ?? "unknown",
        model: ctx?.model ?? "unknown",
        agent_id: ctx?.agentId ?? "unknown",
        run_id: ctx?.runId != null ? String(ctx.runId) : "unknown",
        classification: code ?? "unclassified",
      },
      level: "error",
    });
  }

  // Thread the worker's provider into the render context when the classifier
  // didn't already pull one from the message, so the rendered line can say
  // "Your z-ai provider…" instead of the generic "Your AI provider…".
  if (!context.provider && ctx?.provider) context.provider = ctx.provider;

  try {
    if (code && SILENT_DELTA_CODES.has(code)) {
      // SESSION_TIMEOUT (retried silently) / NO_MODEL_CONFIGURED (dedicated
      // upstream user message): signal for bookkeeping, no user-facing delta.
      await transport.signalError(errorInstance, code, context);
    } else if (code) {
      // CLASSIFIED failure: the gateway renderer owns the user-facing text +
      // CTA (via AGENT_ERRORS). The worker must NOT also emit a formatted delta
      // — doing so is exactly the historical double-formatting that made the
      // same error render differently across surfaces. Signal code + context
      // and let one renderer present it.
      await transport.signalError(errorInstance, code, context);
    } else {
      // UNCLASSIFIED crash: no catalog entry to render from, so the worker
      // still shows its raw crash delta rather than swallowing the failure.
      // Every time this branch fires it's a signal to add a classifier pattern
      // + catalog entry.
      await transport.sendStreamDelta(formatErrorMessage(error), true, true);
      await transport.signalError(errorInstance, code, context);
    }
  } catch (gatewayError) {
    logger.error("Failed to send error via gateway:", gatewayError);
    throw error;
  }
}
