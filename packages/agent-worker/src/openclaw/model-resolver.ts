/**
 * Model resolution and session management helpers.
 * Extracted from worker.ts for clarity.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ConfigProviderMeta, createLogger } from "@lobu/core";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const logger = createLogger("model-resolver");

/** Hardcoded fallback map for provider base URL env vars. */
export const DEFAULT_PROVIDER_BASE_URL_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  "openai-codex": "OPENAI_BASE_URL",
  // Keyed by the gateway provider slug (config id), e.g. "gemini" — NOT
  // "google". registerDynamicProvider() overlays the live config values at
  // runtime; these stay as fallbacks for providers not in providers.json.
  gemini: "GEMINI_API_BASE_URL",
  nvidia: "NVIDIA_API_BASE_URL",
  "z-ai": "Z_AI_API_BASE_URL",
};

/** Default model IDs per provider, used when no explicit model is configured. */
export const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4.1",
  "openai-codex": "gpt-5.1-codex-max",
  // Keyed by gateway slug ("gemini", not "google"). Overridden at runtime by
  // the config-driven defaultModel via registerDynamicProvider().
  gemini: "gemini-2.5-flash",
  nvidia: "nvidia/moonshotai/kimi-k2.5",
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
export interface DynamicOpenAIModel {
  id: string;
  name: string;
  api: "openai-completions";
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
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
  overrides?: { defaultModel?: string; defaultProvider?: string }
): {
  provider: string;
  modelId: string;
} {
  const defaultModelRef =
    overrides?.defaultModel || process.env.AGENT_DEFAULT_MODEL || "";
  const defaultProvider =
    overrides?.defaultProvider || process.env.AGENT_DEFAULT_PROVIDER || "";

  const normalizedRaw = rawModelRef?.trim();
  let modelRef = normalizedRaw || defaultModelRef;

  // When no model is configured but a provider is known, use the provider's
  // default model so auto-mode provider selection works end-to-end.
  if (!modelRef && defaultProvider) {
    const fallbackModel = DEFAULT_PROVIDER_MODELS[defaultProvider];
    if (fallbackModel) {
      logger.info(
        `No model configured, using default for ${defaultProvider}: ${fallbackModel}`
      );
      modelRef = fallbackModel;
    }
  }

  if (!modelRef) {
    throw new Error(
      "No model configured. Ask an admin to connect a provider for the base agent."
    );
  }

  // When the agent has an explicitly configured provider, route to it and pass
  // the model string AS-IS. The model is expressed in that provider's own
  // namespace — e.g. OpenRouter slugs like "anthropic/claude-sonnet-4" or
  // "openai/gpt-4o" mean "OpenRouter's anthropic/openai model", not "switch to
  // the anthropic/openai provider". Splitting on "/" here would mis-route them.
  if (defaultProvider) {
    let modelId = modelRef;
    // Resolve "auto" to the configured provider's default model.
    if (modelId === "auto") {
      const fallback = DEFAULT_PROVIDER_MODELS[defaultProvider];
      if (fallback) {
        logger.info(`Resolved auto model for ${defaultProvider}: ${fallback}`);
        modelId = fallback;
      }
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
    `No provider specified for model "${modelRef}". Use "provider/model" format or set AGENT_DEFAULT_PROVIDER.`
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
