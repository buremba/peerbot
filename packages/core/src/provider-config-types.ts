/**
 * Shared types for config-driven LLM providers.
 * Loaded from the bundled provider registry config.
 */

import type { SdkCompat } from "./sdk-compat";

/**
 * Subscription-login OAuth wire config (data only). Nested under a
 * {@link ProviderConfigEntry} in `config/providers.json`. The gateway loads
 * these at boot — no provider ids are hard-coded in OAuth client code.
 *
 * `id` / display name come from the parent provider entry.
 */
export type ProviderOAuthGrantKind =
  | "authorization-code"
  | "device-code"
  | "openai-device-auth";

export interface ProviderOAuthConfig {
  clientId: string;
  clientSecret?: string;
  /** Authorization-code only. */
  authUrl?: string;
  tokenUrl: string;
  /** Authorization-code + OpenAI device code exchange. */
  redirectUri?: string;
  /** Space-separated scopes. */
  scope: string;
  responseType?: string;
  grantType?: string;
  customHeaders?: Record<string, string>;
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_post"
    | "client_secret_basic";
  requireRefreshToken?: boolean;
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string | number>;
  /** Default `json`. Claude requires `form`. */
  tokenRequestFormat?: "json" | "form";
  /**
   * - `authorization-code` — redirect + paste code#state
   * - `device-code` — RFC 8628 form device code
   * - `openai-device-auth` — OpenAI proprietary JSON device-auth
   */
  grant: ProviderOAuthGrantKind;
  /** Persisted profile authType. Default `oauth`. */
  authType?: "oauth" | "device-code";
  deviceCodeUrl?: string;
  /** OpenAI device-auth poll URL only. */
  deviceTokenUrl?: string;
  deviceRedirectUri?: string;
  defaultVerificationUrl?: string;
  /**
   * When set (e.g. `"user_code"` for xAI), append this query param to the base
   * verification URL with the device user code so the approval page can prefill.
   * When omitted, leave the base URL alone unless the provider returned RFC
   * `verification_uri_complete`. ChatGPT's codex page does not document prefill.
   */
  verificationUserCodeParam?: string;
  pendingStatusCodes?: number[];
  includeScopeInRefresh?: boolean;
  accountIdClaimPath?: string;
  scopeEnvVar?: string;
  userAgent?: string;
}

export interface ProviderConfigEntry {
  /** Display name in settings page (e.g. "Groq") */
  displayName: string;
  /** Provider icon URL */
  iconUrl: string;
  /** Env var name for API key (e.g. "GROQ_API_KEY") */
  envVarName: string;
  /** Provider's API base URL (e.g. "https://api.groq.com/openai") */
  upstreamBaseUrl: string;
  /** HTML help text for the settings page API key input */
  apiKeyInstructions: string;
  /** Placeholder text for the API key input */
  apiKeyPlaceholder: string;
  /**
   * Optional subscription OAuth (Claude / ChatGPT / SuperGrok, etc.).
   * When set, the org inference-providers UI offers "Sign in" for this provider.
   */
  oauth?: ProviderOAuthConfig;
  /**
   * Wire protocol this provider speaks (see SDK_COMPAT_PROTOCOLS). "openai" for
   * OpenAI-compatible providers; "anthropic"/"google"/etc. for others. Omitted ⇒
   * not routable as a config-driven model.
   */
  sdkCompat?: SdkCompat;
  /**
   * models.dev provider key this entry's model catalog is joined from
   * (https://models.dev/api.json, MIT). Purely a DATA-SOURCE pointer — Lobu
   * provider ids are load-bearing in the request path (proxy routing, OAuth
   * config lookup, the immutable stored `kind`) and are never renamed to match
   * models.dev, hence the explicit field instead of an id convention.
   *
   * Lobu names by PRODUCT where models.dev names by VENDOR, so several built-in
   * ids differ (claude→anthropic, chatgpt→openai, gemini→google, …).
   * The mapping is MANY-TO-ONE by design: `chatgpt` (subscription) and `openai`
   * (API key) both point at models.dev's `openai`.
   *
   * OPTIONAL at the type level, and omitting it degrades gracefully: the
   * provider simply gets no snapshot models and the picker falls back to
   * freeform entry. A provider models.dev does not catalog sets
   * `modelsDevExempt: true`; `scripts/check-models-dev-coverage.ts` enforces
   * that every bundled entry either maps or opts out deliberately.
   */
  modelsDevId?: string;
  /**
   * Set true to declare that this provider deliberately has NO models.dev
   * catalog — a custom, self-hosted, or private upstream. Without it, a missing
   * `modelsDevId` fails the coverage guard, so "forgot to map it" and "there is
   * nothing to map" stay distinguishable.
   */
  modelsDevExempt?: boolean;
  /**
   * Modalities this provider actually serves. Omitted ⇒ text only.
   * Gates which per-modality overrides are offered and (for STT) whether the
   * provider is a transcription candidate at all — an OpenAI-compatible chat
   * provider like Cerebras does NOT do speech-to-text, so it must not be listed
   * for `stt`. STT is enabled only when this list includes `"stt"` OR an
   * explicit `stt` block enables it (`enabled !== false`); there is no
   * "default on for openai-compatible" fallback. `image`/`tts` remain
   * additionally gated by their service allowlists; this list is the source of
   * truth for the UI + STT eligibility.
   */
  modalities?: ("text" | "image" | "stt" | "tts")[];
  /** Default model ID when none is configured */
  defaultModel?: string;
  /** Relative path to fetch model list (e.g. "/v1/models") */
  modelsEndpoint?: string;
  /** Override provider name for model registry lookup */
  registryAlias?: string;
  /** Whether to show in "Add Provider" catalog (default: true) */
  catalogVisible?: boolean;
  /**
   * Optional speech-to-text configuration.
   * If omitted and sdkCompat is "openai", STT is enabled with default endpoint/model.
   * Use this block to override endpoint/model or disable STT for a provider.
   */
  stt?: {
    /** Set false to disable STT even when this block exists. */
    enabled?: boolean;
    /** STT protocol compatibility; currently only OpenAI-compatible is supported here. */
    sdkCompat?: "openai";
    /** Optional upstream base URL override for STT requests. */
    baseUrl?: string;
    /** Relative or absolute transcription endpoint path/URL. */
    transcriptionPath?: string;
    /** STT model ID (for OpenAI-compatible endpoints). */
    model?: string;
  };
}

/**
 * One model in the build-time models.dev snapshot
 * (`config/models-dev-snapshot.json`, generated by
 * `scripts/gen-models-dev-snapshot.ts` from https://models.dev/api.json, MIT).
 *
 * A deliberate SUBSET of the upstream record — enough for catalog clients to
 * render cost/context hints without shipping the full upstream schema. Every
 * field but `id`/`name` is optional because upstream coverage is uneven.
 */
export interface ModelsDevSnapshotModel {
  /** Wire model id the provider accepts (e.g. "claude-opus-5"). */
  id: string;
  /** Human label (e.g. "Claude Opus 5"). Falls back to `id` upstream. */
  name: string;
  /** Max input context in tokens. */
  contextLimit?: number;
  /** Max output tokens. */
  outputLimit?: number;
  /** USD per million input tokens. */
  costInput?: number;
  /** USD per million output tokens. */
  costOutput?: number;
  /** Supports tool/function calling. */
  toolCall?: boolean;
  /** Is a reasoning model. */
  reasoning?: boolean;
  /** ISO date (YYYY-MM-DD). */
  releaseDate?: string;
}

/**
 * The committed models.dev snapshot. Loaded from disk at runtime — NEVER
 * fetched: the picker must work offline/air-gapped and on a cold boot.
 */
export interface ModelsDevSnapshot {
  /** Upstream URL, recorded so the artifact is self-describing. */
  source: string;
  /** UTC date (YYYY-MM-DD) the snapshot was generated. */
  generatedAt: string;
  /**
   * Keyed by LOBU provider id (NOT the models.dev id), so callers look up with
   * the id they already hold. Models are sorted newest-release first.
   */
  providers: Record<string, ModelsDevSnapshotModel[]>;
  /**
   * The `modelsDevId` each Lobu provider was joined from, recorded so the
   * coverage guard can detect a mapping edited in providers.json WITHOUT
   * regenerating the snapshot. Without it a renamed mapping still matches the
   * stale snapshot entry by Lobu id and the drift passes silently.
   */
  joinedFrom: Record<string, string>;
}

/** Metadata passed from gateway to worker for config-driven providers. */
export interface ConfigProviderMeta {
  sdkCompat?: SdkCompat;
  defaultModel?: string;
  registryAlias?: string;
  baseUrlEnvVar: string;
}
