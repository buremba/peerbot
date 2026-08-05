import {
  AgentErrorCode,
  createLogger,
  getSentry,
  PROVIDER_BALANCE_EXHAUSTED,
  type WorkerTransport,
} from "@lobu/core";
import { getProviderAuthHintFromError } from "../shared/provider-auth-hints";

const logger = createLogger("worker");

/**
 * Context threaded from `worker.ts` so a captured provider/model failure
 * carries the tags that make "openai doesn't work" triageable in Sentry.
 */
interface ExecutionErrorContext {
  /** Runtime provider/registry alias used for Sentry attribution. */
  provider?: string;
  /** Lobu provider slug used to target the settings CTA. */
  providerSlug?: string;
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
 * THE classifier: message → catalog code. Single source of truth for turning a
 * raw worker/provider failure into an `AgentErrorCode` — every other layer (the
 * worker failure branch, Sentry tagging, the gateway renderers) consumes this
 * rather than re-implementing its own regex. Adding a failure mode = one pattern
 * here + one entry in `AGENT_ERRORS`.
 *
 * Provider errors reach the gateway unchanged with available provider/model
 * context. The renderer uses that context to label the source and unwrap the
 * common JSON message envelope without rewording the provider's sentence.
 */
export function classifyError(error: unknown): AgentErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;

  if (message === SESSION_TIMEOUT_MESSAGE)
    return AgentErrorCode.SESSION_TIMEOUT;

  // Provider usage/rate limit. Covers z.ai's "429 Weekly/Monthly Limit
  // Exhausted", generic rate-limit/quota phrasings, and a bare 429. Placed
  // before PROVIDER_AUTH because a rate-limited request can also echo auth-ish
  // words; the quota shape is the more specific, more actionable signal.
  // Billing/credit exhaustion belongs to the same actionable class as a quota
  // trip: the key is VALID, the account just can't spend. Anthropic returns it
  // as a 400 `invalid_request_error` ("Your credit balance is too low…"), which
  // carries none of the quota vocabulary below — so without this clause it fell
  // through to `undefined` and surfaced as a raw `💥 Worker crashed: 400 {…}`
  // JSON blob in the user's chat.
  if (PROVIDER_BALANCE_EXHAUSTED.test(message))
    return AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED;

  if (
    /weekly\/monthly limit exhausted|limit exhausted|rate[-\s]?limit|quota (?:exceeded|exhausted)|too many requests|\b429\b|resource_exhausted/i.test(
      message
    )
  )
    return AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED;

  // Gemini can end a turn with this provider-side tool-call rejection instead
  // of a usable stop reason. Keep the match specific: other finish reasons can
  // describe different failures and must not inherit this remediation text.
  if (
    /^Provider finish_reason:\s*function_call_filter:\s*MALFORMED_FUNCTION_CALL\b/i.test(
      message
    )
  )
    return AgentErrorCode.PROVIDER_TOOL_CALL_FAILED;

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
    return AgentErrorCode.NO_MODEL_CONFIGURED;
  // Reuse the canonical provider-auth regex (provider-auth-hints.ts) so the
  // classification matches the same auth-failure strings the worker already
  // detects elsewhere.
  if (getProviderAuthHintFromError(message))
    return AgentErrorCode.PROVIDER_AUTH;
  // The gateway secret-proxy 401s with "No provider credentials configured"
  // (code no_credentials) when every credential tier misses. The live red-test
  // (LOBU-BACKEND-W) landed as `unclassified` because the auth-hint regex
  // doesn't cover this shape — and an unclassified event dodges the
  // PROVIDER_* Sentry alert.
  if (
    /no\s+(provider\s+)?credentials\s+configured|no_credentials/i.test(message)
  )
    return AgentErrorCode.PROVIDER_AUTH;
  // The provider accepted the credential but refuses to USE it: Anthropic 403s
  // subscription-OAuth inference for orgs that disallow it
  // (`oauth_not_allowed_for_organization`). None of the wording above matches —
  // there is no "api key" or "authentication failed" — so it surfaced as a raw
  // `Worker crashed: 403 {…}` blob with no CTA. Seen live on Telegram right
  // after connecting Claude by subscription sign-in. The credential is what the
  // user must change, so this is the auth class: "Reconnect provider".
  if (
    /permission_error|oauth[_\s]not[_\s]allowed|not allowed for this organization/i.test(
      message
    )
  )
    return AgentErrorCode.PROVIDER_AUTH;
  // `worker.ts` throws "Model \"<id>\" not found for provider ..." and pi-ai /
  // upstream surface "<x> is not a valid model"/"unknown model"/"model ... not found".
  if (/not a valid model|unknown model|model .* not found/i.test(message))
    return AgentErrorCode.PROVIDER_UNKNOWN_MODEL;
  // model-resolver.ts / session-runner.ts throw this when a non-OpenAI
  // provider cannot be routed through the Lobu gateway proxy. This is usually a
  // provider/model configuration issue, not an agent crash.
  if (
    /Could not resolve a base URL for provider/i.test(message) ||
    /provider is not connected to this agent/i.test(message) ||
    /did not receive the gateway routing URL/i.test(message)
  )
    return AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED;
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

  try {
    // UNCLASSIFIED crash only: no catalog entry to render from, so the worker
    // shows its raw crash delta rather than swallowing the failure. Every time
    // this fires it's a signal to add a classifier pattern + catalog entry.
    // Any CLASSIFIED failure emits NO delta — the gateway renderer presents it
    // (provider message as the body + the code's CTA link). Emitting a delta
    // here too is the historical double-formatting that made the same error
    // render differently across surfaces.
    if (!code) {
      await transport.sendStreamDelta(formatErrorMessage(error), true, true);
    }
    const provider = ctx?.providerSlug ?? ctx?.provider;
    const errorContext =
      provider || ctx?.model
        ? {
            ...(provider ? { provider } : {}),
            ...(ctx?.model ? { model: ctx.model } : {}),
          }
        : undefined;
    await transport.signalError(errorInstance, code, errorContext);
  } catch (gatewayError) {
    logger.error("Failed to send error via gateway:", gatewayError);
    throw error;
  }
}
