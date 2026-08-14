/**
 * Model resolution and session management helpers.
 * Extracted from worker.ts for clarity.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ConfigProviderMeta,
  createLogger,
  type PiAiApi,
  resolveSdkCompat,
  SDK_COMPAT_PROTOCOLS,
} from "@lobu/core";
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
};

/**
 * Map gateway provider slugs to model-registry provider names.
 * The gateway uses slugs like "openai-codex" while the model registry may use
 * a different name; this map bridges the two where they diverge.
 */
export const PROVIDER_REGISTRY_ALIASES: Record<string, string> = {};

/**
 * Registry alias → pi-ai adapter, derived from the protocol registry. Lets the
 * model builder pick the right wire adapter for a dynamic model from just the
 * resolved registry alias. When an alias maps to multiple protocols (e.g.
 * "openai" ← openai + openai-responses), the first wins — openai-completions,
 * the correct default for the common OpenAI-compatible case.
 */
export const PIAI_API_BY_REGISTRY_ALIAS: Record<string, PiAiApi> =
  Object.fromEntries(
    Object.values(SDK_COMPAT_PROTOCOLS)
      .reverse()
      .map((p) => [p.registryAlias, p.api])
  );

function stripOwnProviderPrefix(
  modelId: string,
  ...providerSlugs: Array<string | undefined>
): string {
  for (const providerSlug of new Set(
    providerSlugs.filter((slug): slug is string => Boolean(slug))
  )) {
    if (modelId.startsWith(`${providerSlug}/`)) {
      return modelId.slice(providerSlug.length + 1);
    }
  }
  return modelId;
}

/** Exact adapters for dynamically registered provider slugs. */
const PIAI_API_BY_DYNAMIC_PROVIDER: Record<string, PiAiApi> = {};

/**
 * Resolve the pi-ai wire adapter for a DYNAMIC model entry (one not present in
 * pi-ai's static registry).
 *
 * Real OpenAI is the one exception to the alias-map default: pi-ai's static
 * registry routes every real OpenAI model (gpt-4o, gpt-4.1, gpt-5, …) through
 * the `openai-responses` adapter, and reasoning models like gpt-5.6-sol reject
 * function tools over /chat/completions ("Function tools with reasoning_effort
 * are not supported for gpt-5.6-sol in /v1/chat/completions"). The registry
 * alias cannot make this call — both protocols share the "openai" alias and
 * the alias map collapses to completions — so the adapter is keyed on the raw
 * gateway slug: real OpenAI (`rawProvider === "openai"`) gets responses, while
 * every third-party openai-compatible endpoint (groq, gemini, nvidia,
 * together-ai, org BYO providers, …) keeps completions.
 */
export function resolveDynamicModelApi(
  rawProvider: string,
  registryProvider: string
): PiAiApi | undefined {
  if (rawProvider === "openai") return "openai-responses";
  const registeredApi = PIAI_API_BY_DYNAMIC_PROVIDER[rawProvider];
  if (registeredApi) return registeredApi;
  return PIAI_API_BY_REGISTRY_ALIAS[registryProvider];
}

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

  const protocol = resolveSdkCompat(config.sdkCompat);
  if (protocol && !PIAI_API_BY_DYNAMIC_PROVIDER[id]) {
    PIAI_API_BY_DYNAMIC_PROVIDER[id] = protocol.api;
  }

  if (!alreadyRegistered) {
    DEFAULT_PROVIDER_BASE_URL_ENV[id] = config.baseUrlEnvVar;
  }

  // Always update default model and alias even for pre-registered providers
  if (config.defaultModel && !DEFAULT_PROVIDER_MODELS[id]) {
    DEFAULT_PROVIDER_MODELS[id] = config.defaultModel;
  }

  // Map to model registry name: explicit alias, else the protocol's registry
  // alias (e.g. openai-compatible → "openai", anthropic → "anthropic").
  if (!PROVIDER_REGISTRY_ALIASES[id]) {
    const alias = config.registryAlias || protocol?.registryAlias;
    if (alias) {
      PROVIDER_REGISTRY_ALIASES[id] = alias;
    }
  }

  if (alreadyRegistered) return;

  logger.info(
    `Registered dynamic provider: ${id} (baseUrlEnv=${config.baseUrlEnvVar}, sdkCompat=${config.sdkCompat || "none"})`
  );
}

/** Shape of a dynamically-built model entry (any pi-ai wire protocol). */
interface DynamicModel {
  id: string;
  name: string;
  api: PiAiApi;
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
  compat?: {
    supportsStore: boolean;
  };
}

/**
 * Build a dynamic model entry for a config-driven provider whose model isn't in
 * pi-ai's static registry (gemini, nvidia, together-ai, org BYO providers,
 * …). The `api` selects the pi-ai adapter that speaks the provider's protocol —
 * defaults to openai-completions for the common OpenAI-compatible case.
 *
 * `rawProvider` is the gateway provider slug; `registryProvider` is the
 * model-registry name it maps to.
 *
 * Reliability invariant: only REAL OpenAI may default to OpenAI's public
 * endpoint. For every other provider an unresolved `providerBaseUrl` means the
 * gateway failed to supply a proxy mapping — routing such a request to a public
 * endpoint would silently mis-deliver it with a model ID that endpoint doesn't
 * know, surfacing as a confusing "400 <model> is not a valid model ID". We throw
 * instead so the real cause (no proxy base URL) is visible.
 */
export function buildDynamicOpenAIModel(args: {
  rawProvider: string;
  registryProvider: string;
  modelId: string;
  providerBaseUrl: string | undefined;
  api?: PiAiApi;
}): DynamicModel {
  const { rawProvider, registryProvider, modelId, providerBaseUrl } = args;
  const api = args.api ?? "openai-completions";
  const isRealOpenAI = rawProvider === "openai";
  if (!isRealOpenAI && !providerBaseUrl) {
    throw new Error(
      `The selected model (${rawProvider}/${modelId}) uses provider "${rawProvider}", ` +
        `but Lobu did not receive the gateway routing URL it needs ` +
        `(${DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider] ?? "unknown"}). ` +
        `Connect the provider in the agent's Providers settings, choose a model ` +
        `from a connected provider, or restart/redeploy the gateway if the provider is already connected.`
    );
  }
  return {
    id: modelId,
    name: modelId,
    api,
    provider: registryProvider,
    baseUrl: providerBaseUrl || "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    // pi-ai assumes Chat Completions endpoints accept OpenAI's `store` field.
    // Third-party compat APIs such as Gemini reject it with a protocol-level
    // 400 ("Unknown name 'store'"). Session setup applies the same defensive
    // override to static models; put it on dynamic entries at construction too
    // so every direct consumer gets the production-safe payload.
    ...(api === "openai-completions" && !isRealOpenAI
      ? { compat: { supportsStore: false } }
      : {}),
  };
}

export function resolveModelRef(
  rawModelRef: string,
  overrides?: {
    defaultModel?: string;
    defaultProvider?: string;
    defaultProviderSlug?: string;
    installedProviderRoutes?: Record<string, string>;
  }
): {
  provider: string;
  /** Lobu provider slug retained for exact settings/CTA targeting. */
  providerSlug: string;
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
      "No model resolved for this run. Set the agent's default model, a " +
        "per-behavior model, or an org default inference provider."
    );
  }

  // An explicit "<provider>/<model>" ref selects its own provider — a Behavior
  // pinned to a provider the base agent does not use, or simply an agent pinned
  // to a provider the deployment does not publish as its default. `defaultProvider`
  // is a deployment-level fact and the ref is a run-level one, so the ref wins;
  // its Lobu ID is routed to the upstream runtime slug (claude → anthropic).
  //
  // The installed-route guard is what keeps this fail-safe. It preserves model
  // namespaces such as OpenRouter's "anthropic/claude-sonnet-4", where
  // "anthropic" is not a separately installed provider and the configured
  // OpenRouter route must win, and it stops an uninstalled prefix from
  // conjuring a provider the org never configured. Lobu stores refs as
  // "<lobu-slug>/<model>", so OpenRouter's own entry keeps its prefix
  // ("openrouter/openai/gpt-4o") and never collides with an installed OpenAI.
  //
  // Derived from the RESOLVED `modelRef`, not `normalizedRaw`. A pin is a pin
  // whichever field carries it: most runs have no per-turn model, so the agent's
  // configured `models[0]` arrives as `defaultModel` and `normalizedRaw` is
  // empty. Reading the raw argument here skipped the guard for exactly those
  // runs, and they silently executed on the gateway's fallback-scanned
  // `defaultProvider` with the foreign ref passed through as the model id
  // (observed live: "openai/gpt-5.6-luna" sent to qwen). `defaultProvider` is a
  // fallback-scan result; a configured pin to an INSTALLED provider outranks it.
  const explicitParts = modelRef.split("/").filter(Boolean);
  const explicitProvider = explicitParts[0];
  if (
    explicitParts.length >= 2 &&
    explicitProvider &&
    overrides?.installedProviderRoutes?.[explicitProvider] &&
    explicitProvider !== defaultProvider &&
    explicitProvider !== defaultProviderSlug
  ) {
    const routedProvider = overrides.installedProviderRoutes[explicitProvider];
    let modelId = explicitParts.slice(1).join("/");
    if (modelId === "auto") {
      modelId =
        DEFAULT_PROVIDER_MODELS[explicitProvider] ??
        DEFAULT_PROVIDER_MODELS[routedProvider] ??
        modelId;
    }
    modelId = stripOwnProviderPrefix(modelId, explicitProvider, routedProvider);
    return {
      provider: routedProvider,
      providerSlug: explicitProvider,
      modelId,
    };
  }

  // When the agent has an explicitly configured provider, route to it and pass
  // the model string AS-IS. The model is expressed in that provider's own
  // namespace — e.g. OpenRouter slugs like "anthropic/claude-sonnet-4" or
  // "openai/gpt-4o" mean "OpenRouter's anthropic/openai model", not "switch to
  // the anthropic/openai provider". Splitting on "/" here would mis-route them.
  if (defaultProvider) {
    // Normalize a leading "<configured-provider>/" self-prefix before the
    // sentinel check. Lobu
    // names models "provider/model" ("nvidia/…"), but the upstream
    // provider's own namespace is the bare code — shipping the Lobu
    // prefix makes sdkCompat:openai providers 400 "Unknown
    // Model". Only the configured provider's OWN id is stripped, so a foreign
    // namespace slug (OpenRouter's "anthropic/claude-sonnet-4") stays intact.
    // Normalization runs before the sentinel check so "nvidia/auto" resolves like
    // bare "auto" instead of reaching the upstream API as the literal model
    // "auto".
    //
    // `defaultProvider` is the UPSTREAM slug ("anthropic"); strip that AND the
    // LOBU slug ("claude") when they differ, since the stored model is prefixed
    // with the Lobu id.
    const normalizedModelId = stripOwnProviderPrefix(
      modelRef,
      defaultProvider,
      defaultProviderSlug
    );
    let modelId = modelRef;
    if (normalizedModelId === "auto") {
      const fallback = DEFAULT_PROVIDER_MODELS[defaultProvider];
      if (fallback) {
        logger.info(`Resolved auto model for ${defaultProvider}: ${fallback}`);
        modelId = fallback;
      } else {
        modelId = normalizedModelId;
      }
    }
    // Strip exactly one prefix from the selected model. This covers prefixed
    // provider defaults while preserving an intentional inner namespace in a
    // doubly-prefixed stored ref such as "nvidia/nvidia/moonshotai/...".
    modelId = stripOwnProviderPrefix(
      modelId,
      defaultProvider,
      defaultProviderSlug
    );
    // Reaching here means the ref did NOT name an installed provider other than
    // the configured one — it is the configured provider's own model, a bare
    // model id, or a prefix no installed provider answers to (an aggregator's
    // internal namespace like "anthropic/claude-sonnet-4" with no Anthropic
    // installed, or simply a provider this deployment lacks). None of those
    // names a better route or a reachable CTA target than the configured
    // provider, so routing and attribution both stay on it.
    return {
      provider: defaultProvider,
      providerSlug: defaultProviderSlug || defaultProvider,
      modelId,
    };
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
    return { provider, providerSlug: provider, modelId };
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
