/**
 * Model resolution and session management helpers.
 * Extracted from worker.ts for clarity.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ConfigProviderMeta, createLogger } from "@lobu/core";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const logger = createLogger("model-resolver");

/**
 * Look up a pi-ai registry model by RUNTIME-resolved provider + model strings.
 *
 * pi-ai's `getModel` is generically typed over its static `MODELS` registry
 * (`TProvider extends KnownProvider`, `TModelId extends keyof MODELS[TProvider]`),
 * so it cannot be called with the dynamic strings Lobu resolves at runtime
 * without a cast. Centralize that one unavoidable cast here — behind a typed
 * `(string, string) => Model<any> | undefined` boundary — so call sites stay
 * clean and the dynamic edge is explicit in exactly one place. Returns
 * `undefined` when the registry has no such entry (callers then build a dynamic
 * or cloned model).
 */
export function getModelDynamic(
  provider: string,
  modelId: string
): Model<any> | undefined {
  return getModel(provider as never, modelId as never) as
    | Model<any>
    | undefined;
}

/** Hardcoded fallback map for provider base URL env vars. */
export const DEFAULT_PROVIDER_BASE_URL_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  // Dedicated key (mirrors chatgpt-oauth-module's baseUrlEnvVarName). Must stay
  // distinct from "openai" so the gateway's per-provider base URLs never
  // collide on OPENAI_BASE_URL — see chatgpt-oauth-module.ts.
  "openai-codex": "OPENAI_CODEX_BASE_URL",
  // Keyed by the gateway provider slug (config id), e.g. "gemini" — NOT
  // "google". registerDynamicProvider() overlays the live config values at
  // runtime; these stay as fallbacks for providers not in providers.json.
  gemini: "GEMINI_API_BASE_URL",
  nvidia: "NVIDIA_API_BASE_URL",
  "z-ai": "Z_AI_API_BASE_URL",
};

/**
 * Default model IDs per provider, used when no explicit model is configured.
 * `anthropic` is intentionally absent: its default is resolved live by the
 * gateway (newest model from the API) and delivered via session context, so it
 * never rots to a retired snapshot. The remaining entries are last-ditch
 * fallbacks for providers not present in providers.json (config-driven
 * providers overlay their own defaultModel via registerDynamicProvider()).
 */
export const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  openai: "gpt-4.1",
  "openai-codex": "gpt-5.1-codex-max",
  // Keyed by gateway slug ("gemini", not "google"). Overridden at runtime by
  // the config-driven defaultModel via registerDynamicProvider().
  gemini: "gemini-2.5-flash",
  // NVIDIA's model registry uses the "organization/model" prefix format.
  nvidia: "nvidia/moonshotai/kimi-k2.6",
  "z-ai": "glm-4.7",
};

/**
 * Map gateway provider slugs to model-registry provider names.
 * The gateway uses slugs like "z-ai" while the model registry uses "zai".
 */
export const PROVIDER_REGISTRY_ALIASES: Record<string, string> = {
  "z-ai": "zai",
};

/**
 * Register a config-driven provider at runtime.
 * Extends the base URL env, default model, and registry alias maps
 * so resolveModelRef() and the worker can handle the provider.
 */
export function registerDynamicProvider(
  id: string,
  config: ConfigProviderMeta
): void {
  const alreadyRegistered = !!DEFAULT_PROVIDER_BASE_URL_ENV[id];

  if (!alreadyRegistered) {
    DEFAULT_PROVIDER_BASE_URL_ENV[id] = config.baseUrlEnvVar;
  }

  // Always update default model and alias even for pre-registered providers
  if (config.defaultModel && !DEFAULT_PROVIDER_MODELS[id]) {
    DEFAULT_PROVIDER_MODELS[id] = config.defaultModel;
  }

  // Map to model registry name: explicit alias, or "openai" for sdkCompat providers
  if (!PROVIDER_REGISTRY_ALIASES[id]) {
    const alias =
      config.registryAlias ||
      (config.sdkCompat === "openai" ? "openai" : undefined);
    if (alias) {
      PROVIDER_REGISTRY_ALIASES[id] = alias;
    }
  }

  if (alreadyRegistered) return;

  logger.info(
    `Registered dynamic provider: ${id} (baseUrlEnv=${config.baseUrlEnvVar}, sdkCompat=${config.sdkCompat || "none"})`
  );
}

/** Shape of a dynamically-built openai-completions model entry. */
interface DynamicOpenAIModel {
  id: string;
  name: string;
  api: "openai-completions";
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  // Matches pi-ai's `Model.input` so a dynamic entry is assignable to Model<any>.
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

/**
 * Build a dynamic openai-completions model entry for a config-driven provider
 * whose model isn't in pi-ai's static registry (gemini, nvidia, together-ai,
 * z.ai, …).
 *
 * `rawProvider` is the gateway provider slug; `registryProvider` is the
 * model-registry name it maps to (usually "openai" for sdkCompat providers).
 *
 * Reliability invariant: only REAL OpenAI may default to OpenAI's public
 * endpoint. For every other provider an unresolved `providerBaseUrl` means the
 * gateway failed to supply a proxy mapping — routing such a request to
 * api.openai.com would silently mis-deliver it to OpenAI with a model ID it
 * doesn't know, surfacing as a confusing "400 <model> is not a valid model
 * ID". We throw instead so the real cause (no proxy base URL) is visible.
 */
export function buildDynamicOpenAIModel(args: {
  rawProvider: string;
  registryProvider: string;
  modelId: string;
  providerBaseUrl: string | undefined;
}): DynamicOpenAIModel {
  const { rawProvider, registryProvider, modelId, providerBaseUrl } = args;
  const isRealOpenAI = rawProvider === "openai";
  if (!isRealOpenAI && !providerBaseUrl) {
    throw new Error(
      `Could not resolve a base URL for provider "${rawProvider}". ` +
        `The gateway did not supply a proxy mapping for its base-URL env ` +
        `var (${DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider] ?? "unknown"}). ` +
        `Refusing to route "${modelId}" to OpenAI's public endpoint.`
    );
  }
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: registryProvider,
    baseUrl: providerBaseUrl || "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

export function resolveModelRef(
  rawModelRef: string,
  overrides?: {
    defaultModel?: string;
    defaultProvider?: string;
    defaultProviderSlug?: string;
  }
): {
  provider: string;
  modelId: string;
} {
  const defaultModelRef = overrides?.defaultModel || "";
  const defaultProvider = overrides?.defaultProvider || "";
  // The provider's LOBU id (e.g. "claude"), present only when it differs from
  // `defaultProvider` (the upstream slug, e.g. "anthropic"). Lobu stores models
  // prefixed with the Lobu id, so it must be stripped too — otherwise a
  // "claude/…" model reaches the upstream API verbatim and 404s.
  const defaultProviderSlug = overrides?.defaultProviderSlug || "";

  const normalizedRaw = rawModelRef?.trim();
  const modelRef = normalizedRaw || defaultModelRef;

  // A model must be explicitly configured — Lobu no longer silently picks a
  // provider default, because "newest available" is unreliable (e.g. the
  // Anthropic API lists preview models an account can't actually use). Surface
  // an actionable error so the operator selects a concrete model.
  if (!modelRef) {
    throw new Error(
      "No model selected for this agent. Choose a model in the agent's Providers settings."
    );
  }

  // When the agent has an explicitly configured provider, route to it and pass
  // the model string AS-IS. The model is expressed in that provider's own
  // namespace — e.g. OpenRouter slugs like "anthropic/claude-sonnet-4" or
  // "openai/gpt-4o" mean "OpenRouter's anthropic/openai model", not "switch to
  // the anthropic/openai provider". Splitting on "/" here would mis-route them.
  if (defaultProvider) {
    let modelId = modelRef;
    // Resolve "auto" to the configured provider's default model FIRST — the
    // default itself may carry a redundant prefix (e.g. nvidia →
    // "nvidia/moonshotai/kimi-k2.5"), so stripping has to run after this.
    if (modelId === "auto") {
      const fallback = DEFAULT_PROVIDER_MODELS[defaultProvider];
      if (fallback) {
        logger.info(`Resolved auto model for ${defaultProvider}: ${fallback}`);
        modelId = fallback;
      }
    }
    // Then strip a redundant leading "<configured-provider>/" self-prefix. Lobu
    // names models "provider/model" ("z-ai/glm-4.7"), but the upstream
    // provider's own namespace is the bare code ("glm-4.7") — shipping the Lobu
    // prefix makes z.ai (and other sdkCompat:openai providers) 400 "Unknown
    // Model". Only the configured provider's OWN id is stripped, so a foreign
    // namespace slug (OpenRouter's "anthropic/claude-sonnet-4") stays intact.
    // Runs after the auto-resolution above so a prefixed default is covered too.
    //
    // `defaultProvider` is the UPSTREAM slug ("anthropic"); strip that AND the
    // LOBU slug ("claude") when they differ, since the stored model is prefixed
    // with the Lobu id. Without the second strip, "claude/claude-opus-4-8"
    // reaches the Anthropic API verbatim and 404s.
    if (modelId.startsWith(`${defaultProvider}/`)) {
      modelId = modelId.slice(defaultProvider.length + 1);
    } else if (
      defaultProviderSlug &&
      defaultProviderSlug !== defaultProvider &&
      modelId.startsWith(`${defaultProviderSlug}/`)
    ) {
      modelId = modelId.slice(defaultProviderSlug.length + 1);
    }
    return { provider: defaultProvider, modelId };
  }

  // Auto / no-configured-provider mode: derive the provider from the model
  // string's first segment ("provider/model").
  const parts = modelRef.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const provider = parts[0]!;
    let modelId = parts.slice(1).join("/");
    // Resolve "auto" to the provider's default model
    if (modelId === "auto") {
      const fallback = DEFAULT_PROVIDER_MODELS[provider];
      if (fallback) {
        logger.info(`Resolved auto model for ${provider}: ${fallback}`);
        modelId = fallback;
      }
    }
    return { provider, modelId };
  }

  throw new Error(
    `No provider specified for model "${modelRef}". Use "provider/model" format.`
  );
}

export async function openOrCreateSessionManager(
  sessionFile: string,
  workspaceDir: string
): Promise<SessionManager> {
  try {
    await fs.stat(sessionFile);
    return SessionManager.open(sessionFile);
  } catch {
    const sessionManager = SessionManager.create(
      workspaceDir,
      path.dirname(sessionFile)
    );
    sessionManager.setSessionFile(sessionFile);
    return sessionManager;
  }
}
