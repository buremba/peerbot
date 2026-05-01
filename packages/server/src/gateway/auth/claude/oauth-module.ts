import { createLogger } from "@lobu/core";
import type { ModelOption } from "../../modules/module-system.js";
import { BaseProviderModule } from "../base-provider-module.js";
import { resolveEnv } from "../mcp/string-substitution.js";
import type { OAuthCredentials } from "../oauth/credentials.js";
import {
  type AuthProfilesManager,
  createAuthProfileLabel,
} from "../settings/auth-profiles-manager.js";
import type { ModelPreferenceStore } from "../settings/model-preference-store.js";

const logger = createLogger("claude-oauth-module");

/**
 * Claude OAuth Module - Handles credential injection and model preferences for Claude.
 * OAuth login/logout is handled by the generic settings web page routes.
 */
export class ClaudeOAuthModule extends BaseProviderModule {
  private modelPreferenceStore: ModelPreferenceStore;

  constructor(
    authProfilesManager: AuthProfilesManager,
    modelPreferenceStore: ModelPreferenceStore
  ) {
    super(
      {
        providerId: "claude",
        providerDisplayName: "Claude",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=anthropic.com&sz=128",
        credentialEnvVarName: "CLAUDE_CODE_OAUTH_TOKEN",
        secretEnvVarNames: [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        slug: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        baseUrlEnvVarName: "ANTHROPIC_BASE_URL",
        authType: "oauth",
        supportedAuthTypes: ["oauth", "api-key"],
        apiKeyInstructions:
          'Enter your <a href="https://console.anthropic.com/settings/keys" target="_blank" class="text-blue-600 underline">Anthropic API key</a>:',
        apiKeyPlaceholder: "sk-ant-...",
        catalogDescription: "Anthropic's Claude AI with OAuth authentication",
      },
      authProfilesManager
    );
    // Preserve existing module name
    this.name = "claude-oauth";
    this.modelPreferenceStore = modelPreferenceStore;
  }

  // ---- Overrides for multi-env-var logic ----

  override hasSystemKey(): boolean {
    return !!(
      resolveEnv("ANTHROPIC_AUTH_TOKEN") ||
      resolveEnv("CLAUDE_CODE_OAUTH_TOKEN")
    );
  }

  override injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    if (!envVars.ANTHROPIC_API_KEY && !envVars.CLAUDE_CODE_OAUTH_TOKEN) {
      // Prefer ANTHROPIC_AUTH_TOKEN (explicit user config in .env) over
      // ANTHROPIC_API_KEY (which may be injected by Claude Code's shell env).
      const systemApiKey =
        resolveEnv("ANTHROPIC_AUTH_TOKEN") || resolveEnv("ANTHROPIC_API_KEY");
      const systemOAuthToken = resolveEnv("CLAUDE_CODE_OAUTH_TOKEN");

      if (systemApiKey) {
        envVars.ANTHROPIC_API_KEY = systemApiKey;
      } else if (systemOAuthToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = systemOAuthToken;
      }
    }
    return envVars;
  }

  override async buildEnvVars(
    agentId: string,
    envVars: Record<string, string>,
    context?: import("../../embedded.js").ProviderCredentialContext
  ): Promise<Record<string, string>> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId,
      undefined,
      context
    );

    if (profile?.credential) {
      logger.info(`Injecting ${profile.authType} profile for space ${agentId}`);
      if (profile.authType === "oauth") {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = profile.credential;
      } else {
        envVars.ANTHROPIC_API_KEY = profile.credential;
      }
    }

    // AGENT_DEFAULT_MODEL is now delivered dynamically via session context.
    // No longer baked into static container env vars.

    return envVars;
  }

  getCliBackendConfig() {
    return {
      name: "claude-code",
      command: "npx",
      args: ["-y", "acpx@latest", "claude", "--print"],
      modelArg: "--model",
      sessionArg: "--session",
    };
  }

  async getModelOptions(
    agentId: string,
    userId: string
  ): Promise<ModelOption[]> {
    const availableModels = await this.fetchClaudeModels(agentId);
    if (availableModels.length === 0) return [];

    const preferredModel =
      await this.modelPreferenceStore.getModelPreference(userId);
    logger.debug("Building Claude model options", {
      agentId,
      userId,
      preferredModel,
    });
    const defaultModel =
      preferredModel ||
      process.env.AGENT_DEFAULT_MODEL ||
      "claude-sonnet-4-20250514";
    const options: ModelOption[] = [];
    const seen = new Set<string>();

    const addOption = (value: string, label: string) => {
      if (seen.has(value)) return;
      seen.add(value);
      options.push({ value, label });
    };

    const defaultEntry = availableModels.find((m) => m.id === defaultModel);
    if (defaultEntry) {
      addOption(defaultModel, defaultEntry.display_name || defaultModel);
    }

    for (const model of availableModels) {
      addOption(model.id, model.display_name || model.id);
    }

    return options;
  }

  async setCredentials(
    agentId: string,
    userId: string,
    credentials: unknown
  ): Promise<void> {
    await this.saveOAuthCredentials(
      agentId,
      userId,
      credentials as OAuthCredentials
    );
  }

  async deleteCredentials(agentId: string, userId: string): Promise<void> {
    await this.authProfilesManager.deleteProviderProfiles(
      agentId,
      this.providerId,
      { userId }
    );
  }

  private async saveOAuthCredentials(
    agentId: string,
    userId: string,
    credentials: OAuthCredentials
  ): Promise<void> {
    await this.authProfilesManager.upsertProfile({
      agentId,
      userId,
      provider: this.providerId,
      credential: credentials.accessToken,
      authType: "oauth",
      label: createAuthProfileLabel(
        this.providerDisplayName,
        credentials.accessToken
      ),
      metadata: {
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
      makePrimary: true,
    });
  }

  private static readonly FALLBACK_MODELS: Array<{
    id: string;
    display_name: string;
    type: string;
  }> = [
    {
      id: "claude-sonnet-4-20250514",
      display_name: "Claude Sonnet 4",
      type: "model",
    },
    {
      id: "claude-opus-4-20250514",
      display_name: "Claude Opus 4",
      type: "model",
    },
    {
      id: "claude-haiku-3-5-20241022",
      display_name: "Claude Haiku 3.5",
      type: "model",
    },
  ];

  private async fetchClaudeModels(
    agentId: string
  ): Promise<Array<{ id: string; display_name: string; type: string }>> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId
    );

    const oauthToken =
      profile?.authType === "oauth" ? profile.credential : undefined;
    const apiKey =
      profile?.authType !== "oauth"
        ? profile?.credential
        : process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (oauthToken) {
      headers.Authorization = `Bearer ${oauthToken}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else {
      return ClaudeOAuthModule.FALLBACK_MODELS;
    }

    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers,
    }).catch((err) => {
      logger.warn(
        { error: err?.message, agentId },
        "fetchClaudeModels: fetch failed"
      );
      return null;
    });

    if (!response?.ok) {
      logger.warn(
        {
          agentId,
          status: response?.status,
          hasOauth: !!oauthToken,
          hasApiKey: !!apiKey,
        },
        "fetchClaudeModels: non-ok response, using fallback models"
      );
      return ClaudeOAuthModule.FALLBACK_MODELS;
    }

    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; display_name?: string; type?: string }>;
    };

    const models = (payload.data || [])
      .map((item) => {
        const id = item.id?.trim();
        if (!id) return null;
        return {
          id,
          display_name: item.display_name || id,
          type: item.type || "model",
        };
      })
      .filter(
        (item): item is { id: string; display_name: string; type: string } =>
          Boolean(item)
      );

    return models.length > 0 ? models : ClaudeOAuthModule.FALLBACK_MODELS;
  }
}
