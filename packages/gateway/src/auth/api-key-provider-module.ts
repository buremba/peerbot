import type { ModelOption } from "@lobu/core";
import { BaseProviderModule } from "./base-provider-module";
import type { AgentSettingsStore } from "./settings/agent-settings-store";
import { AuthProfilesManager } from "./settings/auth-profiles-manager";

export interface ApiKeyProviderConfig {
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
  agentSettingsStore: AgentSettingsStore;
}

/**
 * Generic API-key provider module.
 * Any model provider that only needs a "paste your API key" flow
 * can be instantiated from this class without writing a full module.
 */
export class ApiKeyProviderModule extends BaseProviderModule {
  constructor(config: ApiKeyProviderConfig) {
    const authProfilesManager = new AuthProfilesManager(
      config.agentSettingsStore
    );
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
      },
      authProfilesManager
    );
    // Preserve existing module name format
    this.name = `${config.providerId}-api-key`;
  }

  async getModelOptions(
    agentId: string,
    _userId: string
  ): Promise<ModelOption[]> {
    const key = await this.getCredential(agentId);
    if (!key) return [];

    if (this.providerId === "gemini") {
      return this.fetchGeminiModels(key);
    }

    if (this.providerId === "nvidia") {
      return this.fetchNvidiaModels(key);
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
    if (!response || !response.ok) return [];

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

  private async fetchNvidiaModels(apiKey: string): Promise<ModelOption[]> {
    const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    }).catch(() => null);
    if (!response || !response.ok) return [];

    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ id?: string }>;
    };

    return (payload.data || [])
      .map((model) => {
        const id = model.id?.trim();
        if (!id) return null;
        return {
          value: `nvidia/${id}`,
          label: id,
        } satisfies ModelOption;
      })
      .filter((item): item is ModelOption => Boolean(item));
  }
}
