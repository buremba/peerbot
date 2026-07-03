/**
 * Shared types for config-driven LLM providers.
 * Loaded from the bundled provider registry config.
 */

import type { SdkCompat } from "./sdk-compat";

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
   * Wire protocol this provider speaks (see SDK_COMPAT_PROTOCOLS). "openai" for
   * OpenAI-compatible providers; "anthropic"/"google"/etc. for others. Omitted ⇒
   * not routable as a config-driven model.
   */
  sdkCompat?: SdkCompat;
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

/** Metadata passed from gateway to worker for config-driven providers. */
export interface ConfigProviderMeta {
  sdkCompat?: SdkCompat;
  defaultModel?: string;
  registryAlias?: string;
  baseUrlEnvVar: string;
}
