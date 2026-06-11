import { createLogger, getSentry, type WorkerTransport } from "@lobu/core";
import { getProviderAuthHintFromError } from "../shared/provider-auth-hints";

const logger = createLogger("worker");

/**
 * Context threaded from `worker.ts` so a captured provider/model failure
 * carries the tags that make "openai doesn't work" triageable in Sentry.
 */
export interface ExecutionErrorContext {
  provider?: string;
  model?: string;
  agentId?: string;
  runId?: number | string;
}

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
const SILENT_DELTA_CODES = new Set(["SESSION_TIMEOUT", "NO_MODEL_CONFIGURED"]);

export function classifyError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  if (message === SESSION_TIMEOUT_MESSAGE) return "SESSION_TIMEOUT";
  if (
    message.includes("No model configured") ||
    message.includes("No provider specified")
  )
    return "NO_MODEL_CONFIGURED";
  // Reuse the canonical provider-auth regex (provider-auth-hints.ts) so the
  // classification matches the same auth-failure strings the worker already
  // detects elsewhere.
  if (getProviderAuthHintFromError(message)) return "PROVIDER_AUTH";
  // The gateway secret-proxy 401s with "No provider credentials configured"
  // (code no_credentials) when every credential tier misses. The live red-test
  // (LOBU-BACKEND-W) landed as `unclassified` because the auth-hint regex
  // doesn't cover this shape — and an unclassified event dodges the
  // PROVIDER_* Sentry alert.
  if (
    /no\s+(provider\s+)?credentials\s+configured|no_credentials/i.test(message)
  )
    return "PROVIDER_AUTH";
  // `worker.ts` throws "Model \"<id>\" not found for provider ..." and pi-ai /
  // upstream surface "<x> is not a valid model"/"unknown model"/"model ... not found".
  if (/not a valid model|unknown model|model .* not found/i.test(message))
    return "PROVIDER_UNKNOWN_MODEL";
  // model-resolver.ts buildDynamicOpenAIModel throws this when the gateway
  // failed to supply a proxy base URL for a non-OpenAI provider.
  if (/Could not resolve a base URL for provider/i.test(message))
    return "PROVIDER_BASE_URL_UNRESOLVED";
  return undefined;
}

export async function handleExecutionError(
  error: unknown,
  transport: WorkerTransport,
  ctx?: ExecutionErrorContext
): Promise<void> {
  logger.error("Worker execution failed:", error);

  const code = classifyError(error);
  const errorInstance =
    error instanceof Error ? error : new Error(String(error));

  // Report to Sentry Issues. `getSentry()` is DSN-gated and returns null when
  // the worker was spawned without SENTRY_DSN, so this is a safe no-op in dev /
  // self-host. SESSION_TIMEOUT is retried silently — capturing it would be pure
  // noise — so it's the one classification we skip.
  if (code !== "SESSION_TIMEOUT") {
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

  try {
    if (code && SILENT_DELTA_CODES.has(code)) {
      // SESSION_TIMEOUT (retried silently) / NO_MODEL_CONFIGURED (dedicated
      // upstream user message): signal for bookkeeping, no user-facing delta.
      await transport.signalError(errorInstance, code);
    } else {
      // Unclassified crashes AND PROVIDER_* failures still show the user a
      // crash message; the classification rides along on signalError.
      await transport.sendStreamDelta(formatErrorMessage(error), true, true);
      await transport.signalError(errorInstance, code);
    }
  } catch (gatewayError) {
    logger.error("Failed to send error via gateway:", gatewayError);
    throw error;
  }
}
