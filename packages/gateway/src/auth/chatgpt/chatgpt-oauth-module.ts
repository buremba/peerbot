import { createLogger, type ModelOption } from "@lobu/core";
import { BaseProviderModule } from "../base-provider-module";
import type { AgentSettingsStore } from "../settings/agent-settings-store";
import {
  AuthProfilesManager,
  createAuthProfileLabel,
} from "../settings/auth-profiles-manager";
import { ChatGPTDeviceCodeClient } from "./device-code-client";

const logger = createLogger("chatgpt-oauth-module");

/**
 * ChatGPT OAuth Module - Handles device code authentication for ChatGPT.
 * Stores the access token in AgentSettings.envVars as OPENAI_API_KEY.
 * Pi-ai's openai-codex provider picks up OPENAI_API_KEY automatically.
 */
export class ChatGPTOAuthModule extends BaseProviderModule {
  private deviceCodeClient: ChatGPTDeviceCodeClient;

  constructor(agentSettingsStore: AgentSettingsStore) {
    const authProfilesManager = new AuthProfilesManager(agentSettingsStore);
    super(
      {
        providerId: "chatgpt",
        providerDisplayName: "ChatGPT",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=128",
        credentialEnvVarName: "OPENAI_API_KEY",
        secretEnvVarNames: ["OPENAI_API_KEY"],
        slug: "openai-codex",
        upstreamBaseUrl: "https://chatgpt.com/backend-api",
        baseUrlEnvVarName: "OPENAI_BASE_URL",
        authType: "device-code",
        supportedAuthTypes: ["device-code", "api-key"],
        apiKeyInstructions:
          'Enter your <a href="https://platform.openai.com/api-keys" target="_blank" class="text-blue-600 underline">OpenAI API key</a>:',
        apiKeyPlaceholder: "sk-...",
        catalogDescription: "OpenAI's ChatGPT with device code authentication",
      },
      authProfilesManager
    );
    // Preserve existing module name
    this.name = "chatgpt-oauth";
    this.deviceCodeClient = new ChatGPTDeviceCodeClient();
  }

  getCliBackendConfig() {
    return {
      name: "codex",
      command: "npx",
      args: ["-y", "acpx@latest", "codex", "--quiet"],
      modelArg: "--model",
    };
  }

  async getModelOptions(
    agentId: string,
    _userId: string
  ): Promise<ModelOption[]> {
    const token = await this.getCredential(agentId);
    if (!token) return [];

    const response = await fetch("https://chatgpt.com/backend-api/models", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    }).catch(() => null);

    if (!response || !response.ok) {
      return [];
    }

    const payload = (await response.json().catch(() => ({}))) as {
      models?: Array<{
        slug?: string;
        title?: string;
      }>;
    };

    return (payload.models || [])
      .map((model) => {
        const slug = model.slug?.trim();
        if (!slug) return null;
        return {
          value: `openai-codex/${slug}`,
          label: model.title?.trim() || slug,
        } satisfies ModelOption;
      })
      .filter((item): item is ModelOption => Boolean(item));
  }

  /**
   * Get authentication status for ChatGPT provider.
   */
  async getAuthStatus(
    _userId: string,
    agentId: string
  ): Promise<
    Array<{
      id: string;
      name: string;
      isAuthenticated: boolean;
      metadata?: Record<string, any>;
    }>
  > {
    try {
      const hasCredentials = await this.hasCredentials(agentId);
      const isAuthenticated = hasCredentials || this.hasSystemKey();

      return [
        {
          id: "chatgpt",
          name: "ChatGPT",
          isAuthenticated,
          metadata: {
            systemTokenAvailable: this.hasSystemKey(),
          },
        },
      ];
    } catch (error) {
      logger.error("Failed to get ChatGPT auth status", { error });
      return [];
    }
  }

  protected override setupRoutes(): void {
    // Start device code flow
    this.app.post("/start", async (c) => {
      try {
        const result = await this.deviceCodeClient.requestDeviceCode();
        return c.json({
          userCode: result.userCode,
          deviceAuthId: result.deviceAuthId,
          interval: result.interval,
          verificationUrl: "https://auth.openai.com/codex/device",
        });
      } catch (error) {
        logger.error("Failed to start device code flow", { error });
        return c.json({ error: "Failed to start device code flow" }, 500);
      }
    });

    // Poll for token
    this.app.post("/poll", async (c) => {
      try {
        const body = await c.req.json();
        const { deviceAuthId, userCode, agentId } = body;

        if (!deviceAuthId || !userCode || !agentId) {
          return c.json(
            { error: "Missing deviceAuthId, userCode, or agentId" },
            400
          );
        }

        const result = await this.deviceCodeClient.pollForToken(
          deviceAuthId,
          userCode
        );

        if (!result) {
          return c.json({ status: "pending" });
        }

        await this.authProfilesManager.upsertProfile({
          agentId,
          provider: this.providerId,
          credential: result.accessToken,
          authType: "device-code",
          label: createAuthProfileLabel(
            this.providerDisplayName,
            result.accessToken,
            result.accountId
          ),
          metadata: {
            accountId: result.accountId,
            refreshToken: result.refreshToken,
            expiresAt: Date.now() + result.expiresIn * 1000,
          },
          makePrimary: true,
        });

        logger.info(`ChatGPT token saved for agent ${agentId}`);

        return c.json({
          status: "success",
          accountId: result.accountId,
        });
      } catch (error) {
        logger.error("Failed to poll for token", { error });
        return c.json({ error: "Failed to poll for token" }, 500);
      }
    });

    logger.info("ChatGPT auth routes configured");
  }
}
