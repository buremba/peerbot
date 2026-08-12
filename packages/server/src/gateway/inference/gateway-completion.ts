/**
 * Shared gateway-side LLM transport for fail-open enrichment and retrieval
 * features.
 *
 * `suggest-followups` chips and the memory query rewriter are both "prompt in,
 * strict JSON out" features. Routing them through one client avoids separate
 * per-feature credential triples.
 *
 * Credentials resolve through the org's `inference_providers` — the SAME
 * machinery the agent run path uses — so a model an agent can run is a model
 * these features can use. Gateway features resolve the org-owned provider row
 * independently of worker execution.
 *
 * OAuth-backed rows (no API key) and non-OpenAI wire protocols are
 * deliberately unsupported here; the calling feature fails open.
 */

import { createLogger, getErrorMessage, retryWithBackoff } from "@lobu/core";
import {
  getOrgDefaultModel,
  resolveInferenceProviderCredential,
} from "../../lobu/stores/provider-secrets.js";
import { getModelProviderModules } from "../modules/module-system.js";

const logger = createLogger("gateway-completion");

/** A resolved, callable upstream. */
interface GatewayCompletionTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface GatewayCompletionRequest {
  target: GatewayCompletionTarget;
  systemPrompt: string;
  userPrompt: string;
  /** Defaults to 0 — these callers all want deterministic, parseable output. */
  temperature?: number;
  timeoutMs: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null } | null;
  } | null> | null;
}

/**
 * Split a ref on its FIRST `/` into a candidate `{slug, model}`. Returns null
 * only when there is no interior separator at all.
 *
 * This is a syntactic split, not a validation: the caller must confirm the
 * slug names a real provider row before trusting it. Assuming otherwise is a
 * live bug — `anthropic/claude-sonnet-5` is a single provider-NATIVE model id
 * on openrouter, not provider `anthropic`, and a bare `gpt-4o-mini` is a
 * perfectly valid guardrail override rather than a caller error.
 */
function splitModelRef(
  ref: string
): { slug: string; model: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { slug: ref.slice(0, i), model: ref.slice(i + 1) };
}

/**
 * Resolve a callable target from an org + optional model ref.
 *
 * `modelRef` wins when given; otherwise the org's default provider is used.
 * Returns null when the row has no usable API key, upstream, or supported wire
 * protocol.
 */
export async function resolveCompletionTarget(
  organizationId: string,
  modelRef?: string
): Promise<GatewayCompletionTarget | null> {
  const override = modelRef?.trim();
  const orgDefault = override ? null : await getOrgDefaultModel(organizationId);
  const ref = override || orgDefault;
  if (!ref) return null;

  // A guardrail's `model` was historically a RAW model id (`gpt-4o-mini`),
  // posted to one operator-configured base URL. Now that credentials come from
  // the org's provider rows, a ref may also be `<slug>/<model>`. Both must
  // work, and the distinction cannot be made by looking for a "/": provider-
  // native ids contain them (`anthropic/claude-sonnet-5`,
  // `nvidia/moonshotai/kimi-k2.6`).
  //
  // So: try the prefix as a provider slug, and only accept that reading if the
  // org actually HAS such a row. Otherwise treat the whole string as a model
  // name on the org's default provider. Guessing wrong in the old direction
  // silently disabled the feature; this way an operator's existing value keeps
  // working and a qualified ref still routes explicitly.
  const parts = splitModelRef(ref);
  let config = parts
    ? await resolveInferenceProviderCredential(organizationId, parts.slug, "text")
    : null;
  let model = parts?.model;
  let slug = parts?.slug;

  if (!config) {
    const fallbackRef = override
      ? await getOrgDefaultModel(organizationId)
      : null;
    const fallbackParts = fallbackRef ? splitModelRef(fallbackRef) : null;
    if (!fallbackParts) {
      logger.warn(
        { ref },
        "model ref names no provider row and the org has no default; gateway completion skipped"
      );
      return null;
    }
    // Keep the operator's model, borrow the default provider's credentials.
    config = await resolveInferenceProviderCredential(
      organizationId,
      fallbackParts.slug,
      "text"
    );
    model = ref;
    slug = fallbackParts.slug;
  }

  if (!config?.apiKey || !model) return null;

  const providerModule = getModelProviderModules().find(
    (module) => module.providerId === config.kind
  );
  if (providerModule && providerModule.sdkCompat !== "openai") {
    logger.warn(
      { slug, kind: config.kind, sdkCompat: providerModule.sdkCompat },
      "provider does not use the OpenAI-compatible protocol; gateway completion skipped"
    );
    return null;
  }

  // Endpoint precedence: the org row's tenant URL, then the provider module's
  // REGISTERED upstream (which already folds in this deployment's
  // `baseUrlEnvVarName` override), then — only for real OpenAI — the public
  // endpoint.
  //
  // The tail matters: guessing a public endpoint for an unregistered provider
  // would mis-deliver the request to the wrong vendor with a model ID it does
  // not know, surfacing as a baffling "400 <model> is not a valid model ID"
  // rather than "this provider isn't wired up". Mirrors the run path's
  // reliability invariant (`buildDynamicOpenAIModel` in
  // agent-worker/src/runtime/model-resolver.ts). Returning undefined makes the
  // caller skip the feature — a missing chip beats a wrong-vendor call.
  const baseUrl =
    config.baseUrl ??
    providerModule?.getUpstreamConfig?.()?.upstreamBaseUrl ??
    (config.kind === "openai" ? "https://api.openai.com/v1" : undefined);
  if (!baseUrl) {
    logger.warn(
      { slug, kind: config.kind },
      "provider has no text base_url or registered upstream; gateway completion skipped"
    );
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: config.apiKey,
    model,
  };
}

/**
 * An upstream HTTP failure that carries its status so the retry policy can
 * distinguish retryable from terminal responses.
 */
class GatewayCompletionHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GatewayCompletionHttpError";
    this.status = status;
  }
}

/**
 * Whether a gateway-completion failure is worth retrying. Retry ONLY retryable
 * transient conditions: 429/5xx statuses and network errors. A caller-budget
 * abort is terminal because the budget is already exhausted. Auth (401/403),
 * invalid-request (400/404/422), and "no text returned" are terminal too.
 */
function isRetryableGatewayCompletionError(error: Error): boolean {
  if (error instanceof GatewayCompletionHttpError) {
    return error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  return /network|fetch|ECONN/i.test(error.message);
}

/** One attempt at the upstream call. Throws {@link GatewayCompletionHttpError}
 * on non-2xx; returns the assistant text on success. */
async function callCompletionOnce(
  request: GatewayCompletionRequest,
  signal: AbortSignal
): Promise<string> {
  const { target } = request;

  const response = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: target.model,
      temperature: request.temperature ?? 0,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    throw new GatewayCompletionHttpError(
      response.status,
      `Gateway completion failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Gateway completion returned no text");
  return content;
}

/**
 * Call the resolved target and return raw assistant text. Bounded retry with
 * exponential backoff + jitter on retryable transient failures
 * (429/5xx/network). The request's timeoutMs is one shared wall-clock budget
 * across every attempt and delay; a budget abort is never retried. Terminal
 * failures (auth, invalid request, empty content) also stop immediately.
 */
export async function gatewayCompletion(
  request: GatewayCompletionRequest
): Promise<string> {
  const controller = new AbortController();
  const deadline = Date.now() + request.timeoutMs;
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  const baseDelay = 200;
  try {
    return await retryWithBackoff(
      () => callCompletionOnce(request, controller.signal),
      {
        // Two retries add at most <1.2s of backoff (200ms + 400ms, each with
        // a multiplier in [1, 2)). Refuse a retry unless even its maximum
        // upcoming delay fits inside the caller's shared deadline.
        maxRetries: 2,
        baseDelay,
        jitter: "full",
        shouldRetry: (error, attempt) => {
          if (
            controller.signal.aborted ||
            !isRetryableGatewayCompletionError(error)
          ) {
            return false;
          }
          const maxUpcomingDelay = baseDelay * 2 ** (attempt - 1) * 2;
          return Date.now() + maxUpcomingDelay < deadline;
        },
      }
    );
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(getErrorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}
