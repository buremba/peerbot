/**
 * Wire-protocol registry for config-driven providers.
 *
 * `sdkCompat` names the API format a provider speaks. It is a plain metadata
 * dimension — many providers share one protocol — NOT a per-provider special
 * case. Every place that used to assume "openai" now consults this table, so
 * adding a protocol is one row here, not an `if`-chain edit across packages.
 *
 * The `api` field is the pi-ai (`@mariozechner/pi-ai`) adapter the worker uses
 * to actually talk the protocol; `registryAlias` is the model-registry provider
 * name a dynamic model maps to. The gateway proxy is a transparent byte
 * forwarder, so the protocol is chosen entirely on the worker side by picking
 * the right adapter here.
 */

/** Protocols we can route. Extend by adding a `SDK_COMPAT_PROTOCOLS` row. */
export type SdkCompat =
  | "openai"
  | "openai-responses"
  | "anthropic"
  | "google"
  | "bedrock"
  | "mistral";

/** pi-ai API adapter names (mirrors pi-ai's `KnownApi`). */
export type PiAiApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "bedrock-converse-stream"
  | "mistral-conversations";

export interface SdkCompatProtocol {
  /** The pi-ai adapter that speaks this protocol. */
  api: PiAiApi;
  /**
   * Model-registry provider name a dynamic model maps to. Providers speaking
   * the same protocol share a registry alias (e.g. all OpenAI-compatible ones
   * resolve as "openai") unless a provider overrides it via `registryAlias`.
   */
  registryAlias: string;
  /**
   * How an API-KEY credential is presented to the upstream. "x-api-key" for
   * Anthropic; "authorization" (Bearer) or omitted for OpenAI-compatible APIs.
   * The secret proxy applies this at egress for synthesized org providers.
   */
  apiKeyHeader?: "authorization" | "x-api-key";
  /** Human label for logs / UI. */
  label: string;
}

/**
 * The single source of truth mapping a `sdkCompat` to how it routes. Anything
 * NOT in this map is not-yet-routable (the create gate rejects it).
 */
export const SDK_COMPAT_PROTOCOLS: Record<SdkCompat, SdkCompatProtocol> = {
  openai: {
    api: "openai-completions",
    registryAlias: "openai",
    label: "OpenAI-compatible",
  },
  "openai-responses": {
    api: "openai-responses",
    registryAlias: "openai",
    label: "OpenAI Responses",
  },
  anthropic: {
    api: "anthropic-messages",
    registryAlias: "anthropic",
    // Anthropic rejects keys sent as Bearer (401) — they ride in x-api-key.
    apiKeyHeader: "x-api-key",
    label: "Anthropic Messages",
  },
  google: {
    api: "google-generative-ai",
    registryAlias: "google",
    label: "Google Generative AI",
  },
  bedrock: {
    api: "bedrock-converse-stream",
    registryAlias: "bedrock",
    label: "Amazon Bedrock",
  },
  mistral: {
    api: "mistral-conversations",
    registryAlias: "mistral",
    label: "Mistral",
  },
};

/** Is `value` a routable protocol (present in the registry)? */
export function isSdkCompat(
  value: string | null | undefined
): value is SdkCompat {
  return value != null && value in SDK_COMPAT_PROTOCOLS;
}

/** Resolve a `sdkCompat` to its protocol row, or null when not routable. */
export function resolveSdkCompat(
  value: string | null | undefined
): SdkCompatProtocol | null {
  return isSdkCompat(value) ? SDK_COMPAT_PROTOCOLS[value] : null;
}
