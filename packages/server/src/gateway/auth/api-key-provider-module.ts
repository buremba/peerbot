import type { ConfigProviderMeta } from "@lobu/core";
import type { ModelOption } from "../modules/module-system.js";
import { BaseProviderModule } from "./base-provider-module.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";

interface ApiKeyProviderConfig {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl: string;
  envVarName: string;
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  systemEnvVarName?: string;
  /** Provider slug for proxy path routing (e.g. "gemini") */
  slug?: string;
  /** Upstream base URL for proxy forwarding (e.g. "https://generativelanguage.googleapis.com") */
  upstreamBaseUrl?: string;
  /** Explicit base URL env var name (defaults to envVarName with _KEY replaced by _BASE_URL) */
  baseUrlEnvVarName?: string;
  /** Relative path to fetch model list (e.g. "/v1/models"). Enables generic model fetching. */
  modelsEndpoint?: string;
  /** SDK compatibility — "openai" means OpenAI-compatible format. Also maps OPENAI_BASE_URL in proxy. */
  sdkCompat?: "openai";
  /** Default model ID when none is configured */
  defaultModel?: string;
  /** Override provider name for model registry lookup */
  registryAlias?: string;
  /** Whether to show in "Add Provider" catalog (default: true) */
  catalogVisible?: boolean;
  authProfilesManager: AuthProfilesManager;
}

/**
 * Generic API-key provider module.
 * Any model provider that only needs a "paste your API key" flow
 * can be instantiated from this class without writing a full module.
 *
 * Config-driven providers (from providers.json) set sdkCompat,
 * defaultModel, and registryAlias to enable dynamic worker model resolution.
 */
export class ApiKeyProviderModule extends BaseProviderModule {
  protected readonly apiKeyConfig: ApiKeyProviderConfig;

  constructor(config: ApiKeyProviderConfig) {
    super(
      {
        providerId: config.providerId,
        providerDisplayName: config.providerDisplayName,
        providerIconUrl: config.providerIconUrl,
        credentialEnvVarName: config.envVarName,
        secretEnvVarNames: [config.envVarName],
        systemEnvVarName: config.systemEnvVarName,
        slug: config.slug || config.providerId,
        upstreamBaseUrl: config.upstreamBaseUrl,
        baseUrlEnvVarName:
          config.baseUrlEnvVarName ||
          config.envVarName.replace("_KEY", "_BASE_URL"),
        authType: "api-key",
        apiKeyInstructions: config.apiKeyInstructions,
        apiKeyPlaceholder: config.apiKeyPlaceholder,
        catalogVisible: config.catalogVisible,
      },
      config.authProfilesManager
    );
    this.apiKeyConfig = config;
    this.name = `${config.providerId}-api-key`;
  }

  /**
   * For openai-compatible providers, also map OPENAI_BASE_URL so the
   * OpenAI SDK resolves through our proxy.
   */
  override getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string,
    context?: import("../embedded.js").ProviderCredentialContext
  ): Record<string, string> {
    const mappings = super.getProxyBaseUrlMappings(proxyUrl, agentId, context);
    if (this.apiKeyConfig.sdkCompat === "openai") {
      const slug = this.providerConfig.slug || this.providerId;
      mappings.OPENAI_BASE_URL = this.buildAgentScopedProxyUrl(
        proxyUrl,
        slug,
        agentId,
        context
      );
    }
    return mappings;
  }

  /**
   * Returns metadata for config-driven providers (sdkCompat, defaultModel, etc.)
   * so the worker can register them dynamically. Returns null for hardcoded providers.
   */
  getProviderMetadata(): ConfigProviderMeta | null {
    if (
      !this.apiKeyConfig.sdkCompat &&
      !this.apiKeyConfig.defaultModel &&
      !this.apiKeyConfig.registryAlias
    ) {
      return null;
    }
    return {
      sdkCompat: this.apiKeyConfig.sdkCompat,
      defaultModel: this.apiKeyConfig.defaultModel,
      registryAlias: this.apiKeyConfig.registryAlias,
      baseUrlEnvVar:
        this.providerConfig.baseUrlEnvVarName ||
        this.apiKeyConfig.envVarName.replace("_KEY", "_BASE_URL"),
    };
  }

  async getModelOptions(
    agentId: string,
    userId: string
  ): Promise<ModelOption[]> {
    const key = await this.getCredential(agentId, { userId });
    if (!key) return [];

    // Gemini uses a non-standard models endpoint with key-in-query auth
    if (this.providerId === "gemini") {
      return this.fetchGeminiModels(key);
    }

    // Generic modelsEndpoint: supports OpenAI format ({data:[{id}]}) and Ollama format ({models:[{name}]})
    const modelsEndpoint = this.apiKeyConfig.modelsEndpoint;
    if (modelsEndpoint && this.apiKeyConfig.upstreamBaseUrl) {
      return this.fetchModelsGeneric(
        key,
        this.apiKeyConfig.upstreamBaseUrl,
        modelsEndpoint
      );
    }

    return [];
  }

  /**
   * Generic model fetcher using Bearer auth. Works with OpenAI-compatible
   * endpoints ({data:[{id}]}) and Ollama ({models:[{name}]}).
   */
  private async fetchModelsGeneric(
    apiKey: string,
    baseUrl: string,
    endpoint: string
  ): Promise<ModelOption[]> {
    const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    }).catch(() => null);
    if (!response?.ok) return [];

    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string; model?: string }>;
    };

    const prefix = this.providerId;

    // OpenAI format: { data: [{ id: "model-name" }] }
    if (payload.data && Array.isArray(payload.data)) {
      return payload.data
        .map((model) => {
          const id = model.id?.trim();
          if (!id) return null;
          return { value: `${prefix}/${id}`, label: id } satisfies ModelOption;
        })
        .filter((item): item is ModelOption => Boolean(item));
    }

    // Ollama format: { models: [{ name: "model-name", model: "model-name" }] }
    if (payload.models && Array.isArray(payload.models)) {
      return payload.models
        .map((model) => {
          const id = (model.model || model.name)?.trim();
          if (!id) return null;
          return { value: `${prefix}/${id}`, label: id } satisfies ModelOption;
        })
        .filter((item): item is ModelOption => Boolean(item));
    }

    return [];
  }

  private async fetchGeminiModels(apiKey: string): Promise<ModelOption[]> {
    const url = new URL(
      "https://generativelanguage.googleapis.com/v1beta/models"
    );
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    }).catch(() => null);
    if (!response?.ok) return [];

    const payload = (await response.json().catch(() => ({}))) as {
      models?: Array<{ name?: string; displayName?: string }>;
    };

    return (payload.models || [])
      .map((model) => {
        const raw = model.name?.replace(/^models\//, "").trim();
        if (!raw) return null;
        return {
          value: `gemini/${raw}`,
          label: model.displayName || raw,
        } satisfies ModelOption;
      })
      .filter((item): item is ModelOption => Boolean(item));
  }
}
