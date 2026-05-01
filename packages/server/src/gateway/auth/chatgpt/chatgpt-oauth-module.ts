import { createLogger } from "@lobu/core";
import type { ModelOption } from "../../modules/module-system.js";
import { BaseProviderModule } from "../base-provider-module.js";
import {
  type AuthProfilesManager,
  createAuthProfileLabel,
} from "../settings/auth-profiles-manager.js";
import { ChatGPTDeviceCodeClient } from "./device-code-client.js";

const logger = createLogger("chatgpt-oauth-module");

/**
 * ChatGPT OAuth Module - Handles device code authentication for ChatGPT.
 * Stores the access token in auth profiles.
 */
export class ChatGPTOAuthModule extends BaseProviderModule {
  private deviceCodeClient: ChatGPTDeviceCodeClient;

  constructor(authProfilesManager: AuthProfilesManager) {
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

  async buildCredentialPlaceholder(agentId: string): Promise<string> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId
    );
    // Try metadata first, then extract from the stored credential JWT
    let accountId = profile?.metadata?.accountId as string | undefined;
    if (!accountId && profile?.credential) {
      accountId = this.deviceCodeClient.extractAccountId(profile.credential);
    }
    if (!accountId) return "lobu-proxy";

    // Minimal JWT with the chatgpt_account_id claim.
    // Not a valid credential — only used by the codex backend to extract accountId.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      })
    ).toString("base64url");
    return `${header}.${payload}.placeholder`;
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

    if (!response?.ok) {
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

  async startDeviceCode(agentId: string): Promise<{
    userCode: string;
    deviceAuthId: string;
    interval: number;
    verificationUrl: string;
  }> {
    try {
      logger.info("Starting ChatGPT device code flow", { agentId });
      const result = await this.deviceCodeClient.requestDeviceCode();
      return {
        userCode: result.userCode,
        deviceAuthId: result.deviceAuthId,
        interval: result.interval,
        verificationUrl: "https://auth.openai.com/codex/device",
      };
    } catch (error) {
      logger.error("Failed to start device code flow", { error });
      throw new Error("Failed to start device code flow");
    }
  }

  async pollDeviceCode(
    agentId: string,
    userId: string,
    payload: { deviceAuthId: string; userCode: string }
  ): Promise<{
    status: "pending" | "success";
    error?: string;
    accountId?: string;
  }> {
    try {
      const result = await this.deviceCodeClient.pollForToken(
        payload.deviceAuthId,
        payload.userCode
      );

      if (!result) {
        return { status: "pending" };
      }

      await this.authProfilesManager.upsertProfile({
        agentId,
        userId,
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
      return {
        status: "success",
        accountId: result.accountId,
      };
    } catch (error) {
      logger.error("Failed to poll for token", { error });
      throw new Error("Failed to poll for token");
    }
  }
}
